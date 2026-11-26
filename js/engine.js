// Audio graph: two mixer channels, crossfader, effects, master, headphone cue, recording.
export const ctx = new AudioContext({ sampleRate: 44100, latencyHint: 'interactive' });

const dB = (v) => Math.pow(10, v / 20);
const set = (param, v, t = 0.015) => param.setTargetAtTime(v, ctx.currentTime, t);

function meter(node) {
  const an = ctx.createAnalyser();
  an.fftSize = 1024;
  node.connect(an);
  const buf = new Float32Array(an.fftSize);
  let held = 0;
  return () => {
    an.getFloatTimeDomainData(buf);
    let peak = 0;
    for (let i = 0; i < buf.length; i++) { const a = Math.abs(buf[i]); if (a > peak) peak = a; }
    held = Math.max(peak, held * 0.9);
    return held;
  };
}

function reverbImpulse(seconds = 2.4) {
  const n = Math.floor(ctx.sampleRate * seconds);
  const buf = ctx.createBuffer(2, n, ctx.sampleRate);
  for (let c = 0; c < 2; c++) {
    const d = buf.getChannelData(c);
    for (let i = 0; i < n; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / n, 2.6);
  }
  return buf;
}

class Channel {
  constructor(engine) {
    this.engine = engine;
    this.input = ctx.createGain();           // the deck worklet connects here
    this.trim = ctx.createGain();
    this.low = ctx.createBiquadFilter(); this.low.type = 'lowshelf'; this.low.frequency.value = 220;
    this.mid = ctx.createBiquadFilter(); this.mid.type = 'peaking'; this.mid.frequency.value = 1000; this.mid.Q.value = 0.6;
    this.high = ctx.createBiquadFilter(); this.high.type = 'highshelf'; this.high.frequency.value = 3000;
    this.lp = ctx.createBiquadFilter(); this.lp.type = 'lowpass'; this.lp.frequency.value = 22000; this.lp.Q.value = 1.2;
    this.hp = ctx.createBiquadFilter(); this.hp.type = 'highpass'; this.hp.frequency.value = 10; this.hp.Q.value = 1.2;
    // gate: an on/off switch that can be timed to the exact sample (club chops)
    this.gate = ctx.createGain();
    this.fader = ctx.createGain();
    this.xf = ctx.createGain();
    this.cueSend = ctx.createGain(); this.cueSend.gain.value = 0;

    this.input.connect(this.trim).connect(this.low).connect(this.mid).connect(this.high)
      .connect(this.lp).connect(this.hp);
    this.hp.connect(this.gate).connect(this.fader).connect(this.xf).connect(engine.masterIn);
    this.hp.connect(this.cueSend).connect(engine.cueDecks);
    this.level = meter(this.hp);

    // Effects send (post-fader): echo and reverb. Tails ring out after the send closes.
    this.fxSend = ctx.createGain(); this.fxSend.gain.value = 0;
    this.xf.connect(this.fxSend);
    this.delay = ctx.createDelay(4); this.delay.delayTime.value = 0.375;
    this.feedback = ctx.createGain(); this.feedback.gain.value = 0.55;
    this.echoIn = ctx.createGain();
    this.echoIn.connect(this.delay).connect(this.feedback).connect(this.delay);
    this.delay.connect(engine.masterIn);
    this.reverbIn = ctx.createGain(); this.reverbIn.gain.value = 0;
    this.reverb = ctx.createConvolver(); this.reverb.buffer = engine.impulse;
    this.reverbIn.connect(this.reverb).connect(engine.masterIn);
    this.fxSend.connect(this.echoIn);
    this.fxSend.connect(this.reverbIn);

    this.state = { fader: 1, xfGain: 1, fx: 'echo', fxOn: false, fxAmount: 0.5, fxBeats: 0.5, cue: false };
  }

  setTrim(v) { set(this.trim.gain, dB(v * 12)); }                       // v: -1..1 -> ±12 dB
  eqGain(v) { return v < 0 ? v * 40 : v * 6; }                           // kill at -1, +6 dB at 1
  setLow(v) { set(this.low.gain, this.eqGain(v)); }
  setMid(v) { set(this.mid.gain, this.eqGain(v)); }
  setHigh(v) { set(this.high.gain, this.eqGain(v)); }
  // One knob: left = low-pass sweep, right = high-pass sweep, centre = off.
  setFilter(v) {
    const lp = v < -0.02 ? 20000 * Math.pow(80 / 20000, -v) : 22000;
    const hp = v > 0.02 ? 20 * Math.pow(8000 / 20, v) : 10;
    set(this.lp.frequency, lp, 0.02); set(this.hp.frequency, hp, 0.02);
  }
  setFader(v) { this.state.fader = v; set(this.fader.gain, v * v); }
  setCue(on) { this.state.cue = on; set(this.cueSend.gain, on ? 1 : 0); }
  // Level reaching the master (used to crossfade the videos too).
  get outLevel() { return this.state.fader * this.state.xfGain; }

  setFx({ fx, on, amount, beats } = {}, bpm) {
    const s = this.state;
    if (fx !== undefined) s.fx = fx;
    if (on !== undefined) s.fxOn = on;
    if (amount !== undefined) s.fxAmount = amount;
    if (beats !== undefined) s.fxBeats = beats;
    set(this.fxSend.gain, s.fxOn ? s.fxAmount : 0, 0.03);
    set(this.echoIn.gain, s.fx === 'echo' ? 1 : 0);
    set(this.reverbIn.gain, s.fx === 'reverb' ? 1 : 0);
    const beat = 60 / (bpm > 0 ? bpm : 120);
    set(this.delay.delayTime, Math.min(3.9, beat * s.fxBeats), 0.05);
  }
}

class Engine {
  constructor() {
    this.impulse = reverbImpulse();
    this.masterIn = ctx.createGain();
    this.master = ctx.createGain();
    this.limiter = ctx.createDynamicsCompressor();
    this.limiter.threshold.value = -2; this.limiter.knee.value = 0; this.limiter.ratio.value = 20;
    this.limiter.attack.value = 0.002; this.limiter.release.value = 0.12;
    this.masterIn.connect(this.master).connect(this.limiter);

    // Headphone cue bus: pre-fader decks blended with the master.
    this.cueDecks = ctx.createGain();
    this.cueMaster = ctx.createGain(); this.cueMaster.gain.value = 0;
    this.cueBus = ctx.createGain();
    this.cueDecks.connect(this.cueBus);
    this.limiter.connect(this.cueMaster).connect(this.cueBus);

    this.recDest = ctx.createMediaStreamDestination();
    this.limiter.connect(this.recDest);

    const split = ctx.createChannelSplitter(2);
    this.limiter.connect(split);
    const l = ctx.createGain(), r = ctx.createGain();
    split.connect(l, 0); split.connect(r, 1);
    this.masterLevels = [meter(l), meter(r)];

    // Final outputs; route() decides where these two go.
    this.masterOut = ctx.createGain();
    this.limiter.connect(this.masterOut);
    this.cueOut = ctx.createGain();
    this.cueBus.connect(this.cueOut);

    // Auto DJ's drums and sound effects mix in here, before the master limiter.
    this.clubBus = ctx.createGain();
    this.clubBus.gain.value = 0.9;
    this.clubBus.connect(this.masterIn);

    this.channels = [new Channel(this), new Channel(this)];
    this.xfade = 0.5; this.xfCurve = 'smooth';
    this.setCrossfader(0.5);
    this.cueMode = 'off';
    this.route();
  }

  setMaster(v) { set(this.master.gain, v * v * 1.4); }
  setCueVolume(v) { set(this.cueBus.gain, v * v * 1.5); }
  setCueMix(v) { set(this.cueDecks.gain, Math.cos(v * Math.PI / 2)); set(this.cueMaster.gain, Math.sin(v * Math.PI / 2)); }

  setCrossfader(x, curve = this.xfCurve) {
    this.xfade = x; this.xfCurve = curve;
    let a, b;
    if (curve === 'sharp') { a = Math.min(1, (1 - x) * 12); b = Math.min(1, x * 12); }
    else { a = Math.cos(x * Math.PI / 2); b = Math.sin(x * Math.PI / 2); }
    this.channels[0].state.xfGain = a; this.channels[1].state.xfGain = b;
    set(this.channels[0].xf.gain, a, 0.005); set(this.channels[1].xf.gain, b, 0.005);
  }

  // Where master and headphones go:
  //  off     master -> speakers
  //  split   master -> outputs 1-2, headphones -> outputs 3-4 (DJ sound card / controller)
  //  device  master -> speakers, headphones -> a second audio device
  async route(mode = this.cueMode, deviceId) {
    this.masterOut.disconnect();
    this.cueOut.disconnect();
    if (this.cueEl) { this.cueEl.pause(); this.cueEl.srcObject = null; }
    const dest = ctx.destination;

    if (mode === 'split' && dest.maxChannelCount >= 4) {
      dest.channelCount = 4;
      dest.channelCountMode = 'explicit';
      dest.channelInterpretation = 'discrete';
      const merger = ctx.createChannelMerger(4);
      const ms = ctx.createChannelSplitter(2), cs = ctx.createChannelSplitter(2);
      this.masterOut.connect(ms); this.cueOut.connect(cs);
      ms.connect(merger, 0, 0); ms.connect(merger, 1, 1);
      cs.connect(merger, 0, 2); cs.connect(merger, 1, 3);
      merger.connect(dest);
    } else {
      if (mode === 'split') mode = 'off';
      dest.channelCount = Math.min(2, dest.maxChannelCount);
      dest.channelInterpretation = 'speakers';
      this.masterOut.connect(dest);
      if (mode === 'device' && deviceId) {
        this.cueDest ||= ctx.createMediaStreamDestination();
        this.cueOut.connect(this.cueDest);
        this.cueEl ||= new Audio();
        this.cueEl.srcObject = this.cueDest.stream;
        await this.cueEl.setSinkId(deviceId);
        await this.cueEl.play();
      } else if (mode === 'device') mode = 'off';
    }
    this.cueMode = mode;
    return mode;
  }

  async setMasterDevice(deviceId) {
    if (ctx.setSinkId) await ctx.setSinkId(deviceId === 'default' ? '' : deviceId);
  }

  // ----- recording the master mix -----
  startRecording() {
    const type = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4'].find((t) => MediaRecorder.isTypeSupported(t));
    this.recChunks = [];
    this.recorder = new MediaRecorder(this.recDest.stream, { mimeType: type, audioBitsPerSecond: 256000 });
    this.recorder.ondataavailable = (e) => { if (e.data.size) this.recChunks.push(e.data); };
    this.recorder.start(1000);
    this.recStarted = Date.now();
  }

  stopRecording() {
    return new Promise((resolve) => {
      const rec = this.recorder;
      if (!rec) return resolve(null);
      rec.onstop = () => {
        const blob = new Blob(this.recChunks, { type: rec.mimeType });
        this.recorder = null;
        resolve(blob);
      };
      rec.stop();
    });
  }
}

export const engine = new Engine();
// (the version tag makes sure a cached older copy of the worklet is never reused)
export const workletReady = ctx.audioWorklet.addModule(new URL('./deck-worklet.js?v=5', import.meta.url));

// Browsers keep audio suspended until the first click or key press.
const wake = () => { if (ctx.state !== 'running') ctx.resume(); };
addEventListener('pointerdown', wake, true);
addEventListener('keydown', wake, true);
