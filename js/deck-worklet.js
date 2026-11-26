// Deck player running on the audio thread.
// Holds the whole track (or its four stems) as 16-bit PCM and plays it sample-accurately:
// cueing, loops, scratch-style scrubbing, tempo with key lock and key shift (SoundTouch).
import { SoundTouch } from '../vendor/soundtouch.js';

const CHUNK = 512;          // frames fed to the stretcher at a time
const FADE = 1 / 192;       // per-sample fade step for click-free start/stop/seek
const I16 = 1 / 32768;

class DeckProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.sources = [];        // Int16Array, interleaved stereo; 1 = full mix, 4 = stems
    this.gain = [];           // current per-source gain
    this.gainTarget = [];
    this.frames = 0;
    this.pos = 0;             // read head, in source frames (fractional when not stretching)
    this.playing = false;
    this.stopping = false;
    this.vol = 0;             // fade envelope
    this.tempo = 1;
    this.keylock = true;
    this.semis = 0;
    this.loop = null;         // { start, end } in frames
    this.wrapped = false;     // read head has wrapped a loop the listener hasn't reached yet
    this.scrub = null;        // { target, rate }
    this.st = new SoundTouch();
    this.stretching = false;
    this.primed = false;
    this.inBuf = new Float32Array(CHUNK * 2);
    this.outBuf = new Float32Array(128 * 2);
    this.blocks = 0;
    this.endedSent = false;
    this.port.onmessage = (e) => this.onMessage(e.data);
  }

  onMessage(m) {
    switch (m.t) {
      case 'load': {
        this.sources = m.sources.map((b) => new Int16Array(b));
        this.frames = m.frames;
        if (!m.keep) {
          this.pos = 0; this.playing = false; this.vol = 0; this.loop = null; this.scrub = null;
          this.gain = this.sources.map(() => 1);
          this.gainTarget = this.sources.map(() => 1);
        } else {
          this.gain = this.sources.map((_, i) => m.gains?.[i] ?? 1);
          this.gainTarget = this.gain.slice();
          if (this.pos > this.frames) this.pos = this.frames;
        }
        this.endedSent = false;
        this.resetStretch();
        break;
      }
      case 'unload':
        this.sources = []; this.frames = 0; this.pos = 0; this.playing = false; this.loop = null;
        break;
      case 'play':
        this.playing = true; this.stopping = false; this.endedSent = false;
        break;
      case 'pause':
        if (this.playing) this.stopping = true; // fades out, then parks (see process)
        break;
      case 'seek':
        this.pos = Math.max(0, Math.min(this.frames, m.pos));
        this.wrapped = false; this.endedSent = false;
        this.resetStretch();
        this.vol = 0;
        break;
      case 'jump':
        // Relative move (beat sync): applied to wherever playback is right now, so the
        // time this message spent in transit does not turn into a timing error.
        this.pos = Math.max(0, Math.min(this.frames, this.audiblePos() + m.delta));
        this.wrapped = false;
        this.resetStretch();
        this.vol = 0;
        break;
      case 'probe': {
        // troubleshooting: a snapshot of the playback position bookkeeping
        const st = this.st;
        this.port.postMessage({
          t: 'probe', id: m.id, audible: this.audiblePos(), pos: this.pos, primed: this.primed, stretching: this.stretching,
          lead: this.stretchLead(), overlap: st.stretch.overlapLength, tempo: this.tempo, T: st._tempo, R: st._rate,
          buffered: [st.inputBuffer.frameCount, st._intermediateBuffer.frameCount, st.outputBuffer.frameCount], time: currentTime,
        });
        break;
      }
      case 'tempo': this.tempo = m.value; break;
      case 'keylock': this.keylock = m.value; break;
      case 'semis': this.semis = m.value; break;
      case 'loop':
        this.loop = m.loop; this.wrapped = false;
        if (this.loop && this.stretching) {
          // Drop audio already queued past the loop end.
          const a = this.audiblePos();
          if (a < this.loop.end) { this.pos = a; this.resetStretch(); }
        }
        break;
      case 'gains': this.gainTarget = m.gains.slice(); break;
      case 'scrubStart':
        this.pos = this.audiblePos();
        this.resetStretch();
        this.scrub = { target: this.pos, rate: 0 };
        break;
      case 'scrub':
        if (this.scrub) this.scrub.target = Math.max(0, Math.min(this.frames - 1, m.pos));
        break;
      case 'scrubEnd':
        this.scrub = null; this.vol = 0; this.endedSent = false;
        break;
    }
  }

  resetStretch() {
    const st = this.st;
    st.clear();
    st.inputBuffer.clear();
    st.outputBuffer.clear();
    st._intermediateBuffer.clear();
    // Until the stretcher runs again, this.pos is simply where playback should resume.
    this.primed = false;
  }

  // How far (source frames) the stretcher's output runs ahead of what its buffers show.
  // Its overlap search lands about a third of the way into the search range, and each
  // sequence it emits covers more (or less) source than it has consumed so far. Checked
  // against a position ramp run through the stretcher; what remains is its own
  // few-millisecond wobble.
  stretchLead() {
    const st = this.st, sx = st.stretch, T = st._tempo, R = st._rate;
    const lead = 0.33 * sx.seekLength + 0.5 * (1 - T) * (sx.seekWindowLength - sx.overlapLength);
    return R > 1 ? lead : lead * R;
  }

  // Source position the listener is hearing now (the read head minus what is still buffered).
  audiblePos() {
    if (!this.stretching || !this.primed) return this.pos;
    const st = this.st;
    // SoundTouch runs two stages (time-stretch and resample) in an order that depends on
    // the settings; convert what each stage still holds back into source frames.
    const T = st._tempo, R = st._rate, mid = st._intermediateBuffer.frameCount;
    const buffered = st.inputBuffer.frameCount + mid * (R > 1 ? T : R) + st.outputBuffer.frameCount * T * R;
    let p = this.pos - buffered + this.stretchLead();
    if (this.loop && this.wrapped) {
      if (p < this.loop.start) p += this.loop.end - this.loop.start;
      else this.wrapped = false;
    }
    return Math.max(0, p);
  }

  stepGains(n) {
    const k = 1 - Math.exp(-n / 400);
    for (let s = 0; s < this.gain.length; s++) this.gain[s] += (this.gainTarget[s] - this.gain[s]) * k;
  }

  // Mixed sample pair at an integer frame.
  // (Stem gains are applied here, before the stretcher, so four stems cost one stretch.)
  feed(count) {
    const buf = this.inBuf, src = this.sources, g = this.gain;
    let p = Math.floor(this.pos);
    for (let i = 0; i < count; i++) {
      if (this.loop && p >= this.loop.end) { p = this.loop.start; this.wrapped = true; }
      let l = 0, r = 0;
      if (p < this.frames) {
        for (let s = 0; s < src.length; s++) { l += src[s][p * 2] * g[s]; r += src[s][p * 2 + 1] * g[s]; }
      }
      buf[i * 2] = l * I16; buf[i * 2 + 1] = r * I16;
      p++;
    }
    this.pos = p;
    this.stepGains(count);
  }

  process(inputs, outputs) {
    const L = outputs[0][0], R = outputs[0][1] || outputs[0][0];
    const n = L.length;
    if (!this.frames) return true;

    if (this.scrub) this.renderScrub(L, R, n);
    else if (this.playing) {
      const semis = this.semis, tempo = this.tempo;
      const stretch = semis !== 0 || (this.keylock && Math.abs(tempo - 1) > 1e-4);
      if (stretch !== this.stretching) {
        if (!stretch) this.pos = this.audiblePos();
        this.stretching = stretch;
        this.resetStretch();
      }
      if (stretch) this.renderStretch(L, R, n);
      else this.renderDirect(L, R, n, tempo);
      if (this.stopping) {
        // fade out, then park the read head where the listener actually is
        for (let i = 0; i < n; i++) {
          L[i] *= this.vol; R[i] *= this.vol;
          this.vol = Math.max(0, this.vol - FADE);
        }
        if (this.vol === 0) {
          this.pos = this.audiblePos();
          this.playing = false; this.stopping = false;
          this.resetStretch();
        }
      } else if (this.vol < 1) {
        // fade in
        for (let i = 0; i < n; i++) {
          L[i] *= this.vol; R[i] *= this.vol;
          if (this.vol < 1) this.vol = Math.min(1, this.vol + FADE);
        }
      }
      if (this.audiblePos() >= this.frames - 1 && !this.loop) {
        this.playing = false; this.stopping = false; this.pos = this.frames; this.resetStretch();
        if (!this.endedSent) { this.endedSent = true; this.port.postMessage({ t: 'ended' }); }
      }
    }

    if (++this.blocks % 6 === 0) {
      this.port.postMessage({
        t: 'pos', pos: this.audiblePos(), time: currentTime, playing: this.playing && !this.stopping,
        rate: this.scrub ? this.scrub.rate : this.playing ? this.tempo : 0,
      });
    }
    return true;
  }

  renderStretch(L, R, n) {
    const st = this.st;
    const pitch = Math.pow(2, this.semis / 12);
    if (this.keylock) { st.rate = 1; st.tempo = this.tempo; }
    else { st.tempo = 1; st.rate = this.tempo; }
    st.pitch = pitch;
    if (!this.primed) {
      // Starting the stretcher fresh: begin reading slightly early, by the amount its
      // output will run ahead, so what is heard lands exactly on the intended position.
      this.primed = true;
      // (plus one overlap length: the first slice it takes in is folded into the next one)
      const sx = this.st.stretch, R = this.st._rate;
      this.pos = Math.max(0, this.pos - this.stretchLead() - sx.overlapLength * (R > 1 ? 1 : R));
    }
    let guard = 0;
    while (st.outputBuffer.frameCount < n && guard++ < 64) {
      this.feed(CHUNK);
      st.inputBuffer.putSamples(this.inBuf, 0, CHUNK);
      st.process();
    }
    const got = Math.min(n, st.outputBuffer.frameCount);
    st.outputBuffer.receiveSamples(this.outBuf, got);
    for (let i = 0; i < got; i++) { L[i] = this.outBuf[i * 2]; R[i] = this.outBuf[i * 2 + 1]; }
  }

  // Plain varispeed playback with linear interpolation (pitch follows tempo).
  renderDirect(L, R, n, rate) {
    const src = this.sources, g = this.gain, frames = this.frames;
    let pos = this.pos;
    for (let i = 0; i < n; i++) {
      if (this.loop && pos >= this.loop.end) pos -= this.loop.end - this.loop.start;
      const p = Math.floor(pos), f = pos - p;
      let l = 0, r = 0;
      if (p >= 0 && p < frames - 1) {
        for (let s = 0; s < src.length; s++) {
          const a = src[s], k = p * 2;
          l += (a[k] + (a[k + 2] - a[k]) * f) * g[s];
          r += (a[k + 1] + (a[k + 3] - a[k + 1]) * f) * g[s];
        }
      }
      L[i] = l * I16; R[i] = r * I16;
      pos += rate;
    }
    this.pos = pos;
    this.stepGains(n);
  }

  // Scrubbing: chase the pointer's target position, forwards or backwards, like a platter.
  renderScrub(L, R, n) {
    const sc = this.scrub;
    const want = Math.max(-12, Math.min(12, (sc.target - this.pos) / (n * 6)));
    sc.rate += (want - sc.rate) * 0.35;
    if (Math.abs(sc.rate) < 0.002) { sc.rate = 0; return; }
    const loop = this.loop; this.loop = null;
    this.stretching = false;
    this.renderDirect(L, R, n, sc.rate);
    this.loop = loop;
    this.pos = Math.max(0, Math.min(this.frames - 1, this.pos));
  }
}

registerProcessor('deck', DeckProcessor);
