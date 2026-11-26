// One deck: loads a track into its audio worklet and exposes DJ controls.
import { ctx, engine, workletReady } from './engine.js';
import { api } from './api.js';
import { energyProfile } from './energy.js';
import { shiftCamelot } from './setplan.js';

const SR = 44100;
export const STEMS = ['vocals', 'other', 'bass', 'drums'];
export const STEM_LABELS = { vocals: 'Vocals', other: 'Melody', bass: 'Bass', drums: 'Drums' };

export class Deck extends EventTarget {
  constructor(index) {
    super();
    this.index = index;
    this.name = index === 0 ? 'A' : 'B';
    this.channel = engine.channels[index];
    this.reset();
    this.tempo = 1; this.tempoRange = 0.08; this.bend = 0;
    this.keylock = true; this.semis = 0;
    this.other = null;
    workletReady.then(() => {
      this.node = new AudioWorkletNode(ctx, 'deck', { numberOfInputs: 0, outputChannelCount: [2] });
      this.node.connect(this.channel.input);
      this.node.port.onmessage = (e) => this.onNode(e.data);
      this.send('keylock', { value: this.keylock });
    });
  }

  reset() {
    this.track = null; this.frames = 0; this.duration = 0;
    this.bpm = 0; this.firstBeat = 0; this.key = ''; this.camelot = '';
    this.snarePeriod = 0; this.snareFirst = 0; this.loud = null; this.profile = null; this.structure = null;
    this.peaks = null; this.peaksRate = 0;
    this.playing = false; this.report = { pos: 0, time: 0, rate: 0 };
    this.loop = null; this.cuePoint = 0; this.cuePreview = false; this.userCue = false;
    this.hotcues = new Array(8).fill(null);
    this.stemsLoaded = false; this.stemMutes = {}; this.loading = null;
    this.scrubbing = false; this.counted = false; this.pendingPlay = false;
    this.stemsLoading = false; this.loopInPoint = null;
  }

  emit(type, detail) { this.dispatchEvent(new CustomEvent(type, { detail })); }
  send(t, data = {}, transfer) { this.node?.port.postMessage({ t, ...data }, transfer || []); }

  onNode(m) {
    if (m.t === 'pos') {
      this.report = m;
      if (m.playing !== this.playing && !this.pendingPlay) { this.playing = m.playing; this.emit('state'); }
      if (m.playing) this.pendingPlay = false;
    } else if (m.t === 'ended') {
      this.playing = false; this.pendingPlay = false; this.emit('state');
    }
  }

  // ----- position -----
  get pos() { // seconds, extrapolated between worklet reports
    const r = this.report;
    let p = r.pos / SR;
    if (r.rate && !this.scrubbing) p += Math.max(0, Math.min(0.1, ctx.currentTime - r.time)) * r.rate;
    if (this.loop && p >= this.loop.end && r.rate > 0) p -= this.loop.end - this.loop.start;
    return Math.max(0, Math.min(this.duration, p));
  }
  get rate() { return this.tempo * (1 + this.bend); }
  get effectiveBpm() { return this.bpm * this.tempo; }
  get beatLen() { return this.bpm ? 60 / this.bpm : 0; }
  beatPhase(pos = this.pos) {
    if (!this.bpm) return 0;
    const b = (pos - this.firstBeat) / this.beatLen;
    return b - Math.floor(b);
  }
  nearestBeat(pos = this.pos) {
    if (!this.bpm) return pos;
    return Math.max(0, this.firstBeat + Math.round((pos - this.firstBeat) / this.beatLen) * this.beatLen);
  }
  // The backbeat (snare / clap) pattern: what gets lined up between two songs. Falls back
  // to every fourth beat when no clear snare was found.
  get lattice() {
    if (this.snarePeriod > 0) return { period: this.snarePeriod, first: this.snareFirst, snare: true };
    if (this.bpm) return { period: this.beatLen * 4, first: this.firstBeat, snare: false };
    return null;
  }
  // First backbeat at or after a position.
  nextHit(pos = this.pos) {
    const l = this.lattice;
    if (!l) return pos;
    return l.first + Math.ceil((pos - l.first) / l.period - 1e-6) * l.period;
  }
  // ----- song structure: bars, 8-bar phrases, sections -----
  // Falls back to a plain bar grid (from the snare pattern) when the analysis has none.
  get grid() {
    const st = this.structure;
    if (st) return { downbeat: st.downbeat, bar: st.barLen, phraseBars: st.phraseBars, offset: st.phraseOffset };
    if (!this.bpm) return null;
    const bar = this.beatLen * 4;
    const l = this.lattice;
    let downbeat = l ? l.first - Math.min(l.period, bar) / 2 : this.firstBeat;
    downbeat -= Math.floor(downbeat / bar) * bar;
    return { downbeat, bar, phraseBars: 8, offset: 0 };
  }
  get phraseLen() { const g = this.grid; return g ? g.bar * g.phraseBars : 0; }
  // Phrase starts at or after pos (source seconds). step: 1 = phrases, 0.5 = half phrases.
  nextPhrase(pos = this.pos, step = 1) {
    const g = this.grid;
    if (!g) return pos;
    const len = g.bar * g.phraseBars * step, first = g.downbeat + g.offset * g.bar;
    return first + Math.ceil((pos - first) / len - 1e-6) * len;
  }
  phraseAtOrBefore(pos = this.pos) {
    const g = this.grid;
    if (!g) return pos;
    const len = g.bar * g.phraseBars, first = g.downbeat + g.offset * g.bar;
    return Math.max(0, first + Math.floor((pos - first) / len + 1e-6) * len);
  }
  get sections() { return this.structure ? this.structure.sections : []; }
  sectionAt(pos = this.pos) { return this.sections.find((s) => pos >= s.start && pos < s.end) || null; }
  get hook() { return this.structure ? this.structure.hook : null; }
  // Where the song's music begins on the phrase grid (skips silence and count-ins).
  get musicStart() {
    const first = this.sections[0];
    return Math.max(this.soundStart, first ? first.start : 0);
  }

  // Where the music actually starts (skips a silent intro).
  get soundStart() { return this.profile ? this.profile.start : 0; }
  // The latest point a mix out of this song should be finished by: just into its outro,
  // and always before the sound stops.
  get mixOutPoint() {
    const d = this.duration;
    if (!this.profile) return Math.max(0, d - 6);
    return Math.max(0, Math.min(this.profile.tailStart + 2, this.profile.end - 0.5, d - 1));
  }
  // Move playback by a small amount without the message delay turning into a timing error.
  nudgeBy(sec) {
    this.send('jump', { delta: Math.round(sec * SR) });
    this.report = { ...this.report, pos: this.report.pos + sec * SR };
    this.emit('seek');
  }

  // Camelot key as heard, after any key shift.
  get keyCamelot() { return this.semis ? shiftCamelot(this.camelot, this.semis) : this.camelot; }
  // Shifted key name, e.g. "8A +2".
  get keyLabel() { return this.camelot ? this.camelot + (this.semis ? ` ${this.semis > 0 ? '+' : ''}${this.semis}` : '') : ''; }

  // ----- loading -----
  async load(track) {
    await workletReady;
    this.abort?.abort();
    const abort = this.abort = new AbortController();
    this.send('unload');
    this.reset();
    this.track = track; this.duration = track.duration || 0;
    this.bpm = track.bpm || 0; this.firstBeat = track.first_beat || 0;
    this.key = track.key || ''; this.camelot = track.camelot || '';
    this.snarePeriod = track.snare_period || 0; this.snareFirst = track.snare_first || 0; this.loud = track.loud ?? null;
    this.structure = track.structure || null;
    (track.cues || []).forEach((c, i) => { if (i < 8) this.hotcues[i] = c; });
    this.loading = 0;
    this.emit('load'); this.emit('state');

    api.analysis(track.id).then((a) => {
      if (this.track !== track) return;
      this.bpm = a.bpm || 0; this.firstBeat = a.firstBeat || 0; this.key = a.key || ''; this.camelot = a.camelot || '';
      this.snarePeriod = a.snarePeriod || 0; this.snareFirst = a.snareFirst || 0; this.loud = a.loud ?? null;
      this.structure = a.structure || null;
      // hot cues filled in by the analysis, for a song nobody has cued yet
      if (a.cuesAuto && !this.hotcues.some((c) => c != null)) {
        (a.cues || []).forEach((c, i) => { if (i < 8) this.hotcues[i] = c; });
        this.emit('cues');
      }
      if (a.peaks) {
        // the Mac server sends base64 text, the browser version the bytes themselves
        this.peaks = typeof a.peaks === 'string' ? Uint8Array.from(atob(a.peaks), (c) => c.charCodeAt(0)) : new Uint8Array(a.peaks);
        this.peaksRate = a.peaksRate;
        this.profile = energyProfile(this.peaks, this.peaksRate);
      }
      // Start on the first beat unless the DJ has already moved or set a cue.
      if (!this.userCue && !this.playing && this.pos < 0.01 && this.firstBeat > 0.02) {
        this.cuePoint = this.firstBeat; this.seek(this.firstBeat);
      }
      this.updateFx();
      this.emit('analysis');
    }).catch((e) => this.emit('error', e.message));

    try {
      const buf = await api.pcm(track, (p) => { this.loading = p; this.emit('progress'); }, abort.signal);
      if (this.track !== track) return;
      this.frames = buf.byteLength / 4;
      this.duration = this.frames / SR;
      this.send('load', { sources: [buf], frames: this.frames }, [buf]);
      this.send('tempo', { value: this.rate });
      this.send('semis', { value: this.semis });
      this.loading = null;
      if (this.cuePoint) this.seek(this.cuePoint);
      this.emit('ready'); this.emit('state');
      if (track.stems === 1) this.loadStems();
    } catch (e) {
      if (e.name === 'AbortError') return;
      this.loading = null; this.track = null;
      this.emit('error', e.message); this.emit('load'); this.emit('state');
    }
  }

  // Swap the full mix for the four separated stems (position and playback carry on).
  async loadStems() {
    const track = this.track;
    if (!track || this.stemsLoaded || this.stemsLoading) return;
    this.stemsLoading = true; this.emit('stems');
    try {
      const bufs = await Promise.all(STEMS.map((n) => api.stemPcm(track, n, this.abort.signal)));
      if (this.track !== track) return;
      const frames = Math.min(this.frames, ...bufs.map((b) => b.byteLength / 4));
      this.send('load', { sources: bufs, frames, keep: true, gains: STEMS.map((n) => (this.stemMutes[n] ? 0 : 1)) }, bufs);
      this.stemsLoaded = true;
    } catch (e) {
      if (e.name !== 'AbortError') this.emit('error', `Stems could not be loaded: ${e.message}`);
    } finally {
      this.stemsLoading = false; this.emit('stems');
    }
  }

  setStemMute(name, muted) {
    this.stemMutes[name] = muted;
    if (this.stemsLoaded) this.send('gains', { gains: STEMS.map((n) => (this.stemMutes[n] ? 0 : 1)) });
    this.emit('stems');
  }
  // Solo one stem, or pass null to bring everything back.
  soloStem(name) {
    for (const n of STEMS) this.stemMutes[n] = name ? n !== name : false;
    if (this.stemsLoaded) this.send('gains', { gains: STEMS.map((n) => (this.stemMutes[n] ? 0 : 1)) });
    this.emit('stems');
  }

  // ----- transport -----
  get ready() { return this.frames > 0; }
  play() {
    if (!this.ready || this.playing) return;
    if (ctx.state !== 'running') ctx.resume();
    if (this.pos >= this.duration - 0.05) this.seek(this.cuePoint);
    this.send('play');
    this.playing = true; this.pendingPlay = true;
    if (!this.counted) { this.counted = true; api.played(this.track.id).catch(() => {}); }
    this.emit('state');
  }
  pause() {
    if (!this.playing) return;
    this.send('pause');
    this.playing = false; this.pendingPlay = false;
    this.report = { ...this.report, pos: this.pos * SR, rate: 0 };
    this.emit('state');
  }
  toggle() { this.playing ? this.pause() : this.play(); }
  seek(sec) {
    if (!this.ready) return;
    sec = Math.max(0, Math.min(this.duration, sec));
    this.send('seek', { pos: Math.round(sec * SR) });
    this.report = { pos: sec * SR, time: ctx.currentTime, rate: this.playing ? this.rate : 0, playing: this.playing };
    this.emit('seek');
  }

  // Cue button, CDJ style: while playing it returns to the cue point and stops; while
  // stopped it sets the cue point, or (held at the cue point) plays until released.
  cueDown() {
    if (!this.ready) return;
    if (this.playing && !this.cuePreview) { this.pause(); this.seek(this.cuePoint); return; }
    if (Math.abs(this.pos - this.cuePoint) < 0.03) { this.cuePreview = true; this.play(); return; }
    this.cuePoint = this.pos; this.userCue = true; this.emit('cues');
  }
  cueUp() {
    if (!this.cuePreview) return;
    this.cuePreview = false; this.pause(); this.seek(this.cuePoint);
  }

  hotcue(i) {
    if (!this.ready) return;
    if (this.hotcues[i] == null) {
      this.hotcues[i] = Math.round(this.pos * 1000) / 1000;
      this.saveCues();
    } else {
      this.seek(this.hotcues[i]);
      if (this.loop && (this.hotcues[i] < this.loop.start || this.hotcues[i] >= this.loop.end)) this.exitLoop();
    }
    this.emit('cues');
  }
  clearHotcue(i) { this.hotcues[i] = null; this.saveCues(); this.emit('cues'); }
  saveCues() { if (this.track) api.saveTrack(this.track.id, { cues: this.hotcues }).then((t) => { this.track.cues = t.cues; }).catch(() => {}); }

  // ----- tempo and key -----
  setTempo(ratio) {
    this.tempo = Math.max(0.5, Math.min(1.5, ratio));
    this.send('tempo', { value: this.rate });
    this.updateFx();
    this.emit('tempo');
  }
  setTempoRange(r) {
    this.tempoRange = r;
    this.setTempo(Math.max(1 - r, Math.min(1 + r, this.tempo)));
  }
  // Momentary nudge to line beats up by ear (like pushing a platter).
  setBend(b) { this.bend = b; this.send('tempo', { value: this.rate }); }
  setKeylock(on) { this.keylock = on; this.send('keylock', { value: on }); this.emit('tempo'); }
  setSemis(n) { this.semis = Math.max(-12, Math.min(12, n)); this.send('semis', { value: this.semis }); this.emit('tempo'); }
  updateFx() { this.channel.setFx({}, this.effectiveBpm); }

  // Match the other deck's tempo and line the beats up.
  sync() {
    const o = this.other;
    if (!this.bpm || !o?.bpm) return false;
    let ratio = o.effectiveBpm / this.bpm;
    while (ratio > 1.42) ratio /= 2;
    while (ratio < 0.71) ratio *= 2;
    const need = Math.abs(ratio - 1);
    if (need > this.tempoRange + 1e-6) this.tempoRange = need <= 0.08 ? 0.08 : need <= 0.16 ? 0.16 : 0.5;
    this.setTempo(ratio);
    // Line up the backbeats: this deck's next snare lands on the other deck's next snare.
    const align = (min) => {
      const mine = this.lattice, theirs = o.lattice;
      if (!o.playing || !this.ready || !mine || !theirs) return;
      const untilMine = (this.nextHit() - this.pos) / this.rate;       // seconds of real time
      const untilTheirs = (o.nextHit() - o.pos) / o.rate;
      const fold = Math.min(mine.period / this.rate, theirs.period / o.rate);
      let d = untilMine - untilTheirs;                                  // + means I am late
      d -= Math.round(d / fold) * fold;
      if (Math.abs(d) > min) this.nudgeBy(d * this.rate);
    };
    align(0);
    // Once the audio has settled after the jump, trim any few-millisecond remainder.
    clearTimeout(this.syncTimer);
    this.syncTimer = setTimeout(() => { if (this.playing) align(0.004); }, 450);
    return true;
  }

  // ----- loops -----
  setLoop(start, end, beats = null) {
    if (!this.ready) return;
    start = Math.max(0, start); end = Math.min(this.duration, end);
    if (end - start < 0.01) return;
    this.loop = { start, end, beats };
    this.send('loop', { loop: { start: Math.round(start * SR), end: Math.round(end * SR) } });
    if (this.pos >= end) this.seek(start);
    this.emit('loop');
  }
  exitLoop() { this.loop = null; this.loopInPoint = null; this.send('loop', { loop: null }); this.emit('loop'); }
  // Loop a number of beats from the nearest beat. Pressing the active size again exits.
  autoLoop(beats) {
    if (!this.ready) return;
    if (this.loop && this.loop.beats === beats) return this.exitLoop();
    const len = (this.bpm ? this.beatLen : 0.5) * beats;
    const start = this.loop ? this.loop.start : beats >= 1 ? this.nearestBeat() : this.pos;
    this.setLoop(start, start + len, beats);
  }
  scaleLoop(f) {
    if (!this.loop) return;
    const len = (this.loop.end - this.loop.start) * f;
    if (len < 0.02 || len > 120) return;
    this.setLoop(this.loop.start, this.loop.start + len, this.loop.beats ? this.loop.beats * f : null);
  }
  loopIn() { if (this.ready) { this.loopInPoint = this.pos; this.emit('loop'); } }
  loopOut() {
    if (this.loopInPoint != null && this.pos > this.loopInPoint) {
      this.setLoop(this.loopInPoint, this.pos);
      this.seek(this.loopInPoint);
    }
  }

  // ----- scrubbing (drag the waveform) -----
  scrubStart() { if (!this.ready) return; this.scrubbing = true; this.scrubPos = this.pos; this.send('scrubStart'); }
  scrubTo(sec) {
    if (!this.scrubbing) return;
    this.scrubPos = Math.max(0, Math.min(this.duration, sec));
    this.send('scrub', { pos: Math.round(this.scrubPos * SR) });
  }
  scrubEnd() {
    if (!this.scrubbing) return;
    this.scrubbing = false;
    this.send('scrubEnd');
    this.emit('seek');
  }
}
