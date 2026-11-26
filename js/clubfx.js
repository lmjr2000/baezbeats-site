// Club sound effects and Auto DJ's drum parts.
// Everything is synthesized here (no samples) and scheduled at exact AudioContext times, so
// it lands on the music's beats. It all plays through engine.clubBus, before the limiter,
// so it is in recorded mixes too.
import { ctx, engine } from './engine.js';

const noiseBuf = (() => {
  const n = ctx.sampleRate * 2, b = ctx.createBuffer(1, n, ctx.sampleRate), d = b.getChannelData(0);
  for (let i = 0; i < n; i++) d[i] = Math.random() * 2 - 1;
  return b;
})();
const fxOut = ctx.createGain();
fxOut.gain.value = 0.55;
fxOut.connect(engine.clubBus);

function env(g, t, a, peak, hold, rel) {
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(peak, t + a);
  g.gain.setValueAtTime(peak, t + a + hold);
  g.gain.exponentialRampToValueAtTime(0.0001, t + a + hold + rel);
}

// ---------- sound effects ----------
// Air horn: three blasts of a bright, slightly detuned brass-like stack (short, short, long).
function airHorn(t, beat = 0.4) {
  const blasts = [[0, beat * 0.45], [beat * 0.5, beat * 0.45], [beat, beat * 1.6]];
  for (const [off, len] of blasts) {
    const g = ctx.createGain(), bp = ctx.createBiquadFilter(), shaper = ctx.createWaveShaper();
    bp.type = 'bandpass'; bp.frequency.value = 1400; bp.Q.value = 0.8;
    const curve = new Float32Array(256);
    for (let i = 0; i < 256; i++) { const x = i / 128 - 1; curve[i] = Math.tanh(3 * x); }
    shaper.curve = curve;
    shaper.connect(bp).connect(g).connect(fxOut);
    for (const f of [466, 470, 932, 699]) {
      const o = ctx.createOscillator();
      o.type = 'sawtooth';
      o.frequency.setValueAtTime(f * 1.03, t + off);
      o.frequency.exponentialRampToValueAtTime(f, t + off + 0.06);
      o.connect(shaper);
      o.start(t + off); o.stop(t + off + len + 0.1);
    }
    env(g, t + off, 0.01, 0.35, len - 0.06, 0.05);
  }
}

// Siren: a dub-style wail, pitch swept by a slow wobble.
function siren(t, dur = 1.6) {
  const o = ctx.createOscillator(), lfo = ctx.createOscillator(), depth = ctx.createGain(), g = ctx.createGain();
  o.type = 'square'; o.frequency.value = 750;
  lfo.frequency.setValueAtTime(3, t); lfo.frequency.linearRampToValueAtTime(7, t + dur);
  depth.gain.value = 260;
  lfo.connect(depth).connect(o.frequency);
  const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 2600;
  o.connect(lp).connect(g).connect(fxOut);
  env(g, t, 0.05, 0.16, dur - 0.25, 0.2);
  o.start(t); lfo.start(t); o.stop(t + dur + 0.1); lfo.stop(t + dur + 0.1);
}

// Riser: filtered noise and a rising tone that build into a drop at t + dur.
function riser(t, dur) {
  const src = ctx.createBufferSource(), bp = ctx.createBiquadFilter(), g = ctx.createGain();
  src.buffer = noiseBuf; src.loop = true;
  bp.type = 'bandpass'; bp.Q.value = 1.5;
  bp.frequency.setValueAtTime(300, t); bp.frequency.exponentialRampToValueAtTime(9000, t + dur);
  g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(0.45, t + dur * 0.97); g.gain.linearRampToValueAtTime(0, t + dur);
  src.connect(bp).connect(g).connect(fxOut);
  src.start(t); src.stop(t + dur + 0.05);
  const o = ctx.createOscillator(), og = ctx.createGain();
  o.type = 'sine';
  o.frequency.setValueAtTime(180, t); o.frequency.exponentialRampToValueAtTime(1400, t + dur);
  og.gain.setValueAtTime(0.0001, t); og.gain.exponentialRampToValueAtTime(0.12, t + dur * 0.97); og.gain.linearRampToValueAtTime(0, t + dur);
  o.connect(og).connect(fxOut);
  o.start(t); o.stop(t + dur + 0.05);
}

// Impact: a deep boom with a burst of noise, for the moment a new song drops.
function impact(t) {
  const o = ctx.createOscillator(), g = ctx.createGain();
  o.type = 'sine';
  o.frequency.setValueAtTime(110, t); o.frequency.exponentialRampToValueAtTime(32, t + 0.9);
  env(g, t, 0.005, 0.9, 0.05, 1.1);
  o.connect(g).connect(fxOut);
  o.start(t); o.stop(t + 1.3);
  const n = ctx.createBufferSource(), ng = ctx.createGain(), lp = ctx.createBiquadFilter();
  n.buffer = noiseBuf; lp.type = 'lowpass'; lp.frequency.setValueAtTime(5000, t); lp.frequency.exponentialRampToValueAtTime(200, t + 0.4);
  env(ng, t, 0.002, 0.35, 0.01, 0.4);
  n.connect(lp).connect(ng).connect(fxOut);
  n.start(t); n.stop(t + 0.6);
}

export const fx = { airHorn, siren, riser, impact };

// ---------- drums ----------
// The drums follow the music: give them beat times worked out from a deck.
export function buildClubDrums(seq) {
  // A snare roll that speeds up into the drop: 8ths, then 16ths, then 32nds, getting louder.
  function fill(t, beat, beats = 4) {
    const parts = beats >= 4 ? [[0, 2, 2], [2, 1, 4], [3, 1, 8]] : [[0, beats / 2, 4], [beats / 2, beats / 2, 8]];
    for (const [start, len, per] of parts) {
      const n = len * per;
      for (let i = 0; i < n; i++) {
        const at = start + i / per;
        seq.hitAt('Snare', t + at * beat, 0.25 + 0.6 * (at / beats));
      }
    }
  }
  // Kick and clap on the "one" where the new song comes in (plus an open hat).
  function punch(t) {
    seq.hitAt('Kick', t, 1); seq.hitAt('Clap', t, 0.8); seq.hitAt('Open hat', t, 0.5);
  }
  // A plain groove for a bar or two, so the floor never goes quiet under a spinback or brake.
  // feel: 'club' (four on the floor), 'trap' (half-time) or 'boombap'.
  function bed(t, beat, bars, feel) {
    for (let b = 0; b < bars * 4; b++) {
      const at = t + b * beat, inBar = b % 4;
      if (feel === 'club') { seq.hitAt('Kick', at, 0.9); if (inBar % 2) seq.hitAt('Clap', at, 0.7); seq.hitAt('Open hat', at + beat / 2, 0.35); }
      else if (feel === 'trap') {
        if (inBar === 0) seq.hitAt('Kick', at, 1);
        if (inBar === 2) seq.hitAt('Clap', at, 0.85);
        if (inBar === 3) seq.hitAt('Kick', at + beat / 2, 0.8);
        for (let k = 0; k < 2; k++) seq.hitAt('Closed hat', at + (k * beat) / 2, 0.4);
        if (inBar === 3) for (let k = 0; k < 4; k++) seq.hitAt('Closed hat', at + beat / 2 + (k * beat) / 8, 0.3);
      } else {
        if (inBar === 0 || inBar === 2) seq.hitAt('Kick', at, 0.95);
        if (inBar === 2) seq.hitAt('Kick', at + beat * 0.75, 0.6);
        if (inBar % 2) seq.hitAt('Snare', at, 0.8);
        seq.hitAt('Closed hat', at, 0.35); seq.hitAt('Closed hat', at + beat / 2, 0.25);
      }
    }
  }
  return { fill, punch, bed };
}

// Which groove suits a deck: half-time snare (once a bar) means trap, quick tempos with a
// snare on 2 and 4 get four-on-the-floor, the rest boom-bap.
export function feelOf(deck) {
  const beats = deck.snarePeriod && deck.bpm ? Math.round(deck.snarePeriod / (60 / deck.bpm)) : 2;
  if (beats >= 4) return 'trap';
  return deck.effectiveBpm >= 118 ? 'club' : 'boombap';
}
