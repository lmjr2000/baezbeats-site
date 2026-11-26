// Song structure: bars, 8-bar phrases, and sections (intro, verse, hook, break, outro).
//
// Everything is measured bar by bar on the beat grid found by the tempo analysis:
//  - each bar is described by the notes heard on each of its 4 beats (beat-synchronous chroma)
//    plus its loudness
//  - phrases: the bar grid is split into 8-bar phrases at the offset where the music changes
//    the most (new sections start on phrase starts)
//  - hook: the phrase that repeats most exactly elsewhere in the song. A verse has the same
//    beat but new words each time; a hook comes back note for note.
import { fft, hann } from './dsp.js';

const N = 4096, HOP = 1024;
const PHRASE = 8;          // bars per phrase
const WIN = 4;             // bars each side when looking for changes

// Per-frame notes (12 pitch classes) and loudness.
function frames(x, sr) {
  const nf = Math.max(0, Math.floor((x.length - N) / HOP));
  const chroma = new Float32Array(nf * 12), rms = new Float32Array(nf);
  const win = hann(N), re = new Float32Array(N), im = new Float32Array(N);
  const kLo = Math.ceil((80 * N) / sr), kHi = Math.floor((3000 * N) / sr);
  const pc = new Int8Array(kHi + 2), wt = new Float32Array(kHi + 2);
  for (let k = kLo; k <= kHi; k++) {
    const midi = 69 + 12 * Math.log2((k * sr) / N / 440);
    const near = Math.round(midi);
    pc[k] = ((near % 12) + 12) % 12;
    wt[k] = Math.cos((midi - near) * Math.PI) ** 2;
  }
  const mag = new Float32Array(kHi + 2);
  for (let f = 0; f < nf; f++) {
    const o = f * HOP;
    let e = 0;
    for (let i = 0; i < N; i++) { const v = x[o + i]; re[i] = v * win[i]; im[i] = 0; e += v * v; }
    rms[f] = Math.sqrt(e / N);
    fft(re, im);
    for (let k = kLo - 1; k <= kHi + 1; k++) mag[k] = Math.hypot(re[k], im[k]);
    for (let k = kLo; k <= kHi; k++) {
      if (mag[k] > mag[k - 1] && mag[k] >= mag[k + 1]) chroma[f * 12 + pc[k]] += Math.sqrt(mag[k]) * wt[k];
    }
  }
  return { chroma, rms, nf, fps: sr / HOP, offset: N / 2 / sr };
}

const median = (a) => { const s = [...a].sort((x, y) => x - y); return s.length ? s[Math.floor(s.length / 2)] : 0; };

// tempo: { bpm, firstBeat, snarePeriod, snareFirst } from detectTempo.
export function detectStructure(x, sr, tempo) {
  const { bpm, firstBeat, snarePeriod, snareFirst } = tempo || {};
  const duration = x.length / sr;
  if (!(bpm > 0) || duration < 30) return null;
  const beat = 60 / bpm, barLen = 4 * beat;

  // Bar starts: the snare sits on beats 2 and 4 (or on 3 in half-time), so the bar
  // begins half a snare period (at most two beats) before a snare.
  let downbeat = firstBeat;
  if (snarePeriod > 0) downbeat = snareFirst - Math.min(snarePeriod, barLen) / 2;
  downbeat -= Math.floor(downbeat / barLen) * barLen;
  const nb = Math.floor((duration - downbeat) / barLen);
  if (nb < 16) return null;

  // ----- per-bar description -----
  const F = frames(x, sr);
  const frameAt = (t) => Math.max(0, Math.min(F.nf - 1, Math.round((t - F.offset) * F.fps)));
  const vec = new Float32Array(nb * 48), energy = new Float32Array(nb);
  for (let b = 0; b < nb; b++) {
    const t0 = downbeat + b * barLen;
    let e = 0, ec = 0;
    for (let q = 0; q < 4; q++) {
      const f0 = frameAt(t0 + q * beat), f1 = Math.max(f0 + 1, frameAt(t0 + (q + 1) * beat));
      const slot = vec.subarray(b * 48 + q * 12, b * 48 + q * 12 + 12);
      for (let f = f0; f < f1; f++) {
        for (let c = 0; c < 12; c++) slot[c] += F.chroma[f * 12 + c];
        e += F.rms[f]; ec++;
      }
      let n = 0;
      for (let c = 0; c < 12; c++) n += slot[c] * slot[c];
      n = Math.sqrt(n) || 1;
      for (let c = 0; c < 12; c++) slot[c] /= n;
    }
    energy[b] = ec ? e / ec : 0;
  }
  const sim = (i, j) => {
    let s = 0;
    const a = i * 48, c = j * 48;
    for (let k = 0; k < 48; k++) s += vec[a + k] * vec[c + k];
    return s / 4;
  };
  const eMed = median(energy.filter((v) => v > 0)) || 1e-6;
  const loudBar = (b) => energy[b] >= 0.2 * eMed;

  // ----- where the music changes (a boundary before bar i) -----
  const nov = new Float32Array(nb);
  for (let i = WIN; i <= nb - WIN; i++) {
    let within = 0, cross = 0, cw = 0, cc = 0;
    for (let a = i - WIN; a < i + WIN; a++) {
      for (let b = a + 1; b < i + WIN; b++) {
        const s = sim(a, b);
        if ((a < i) === (b < i)) { within += s; cw++; } else { cross += s; cc++; }
      }
    }
    let eA = 0, eB = 0;
    for (let k = 0; k < WIN; k++) { eA += energy[i - WIN + k]; eB += energy[i + k]; }
    const jump = Math.abs(Math.log((eB + 1e-6) / (eA + 1e-6)));
    nov[i] = Math.max(0, within / cw - cross / cc) + 0.35 * jump;
  }

  // ----- phrase grid: the 8-bar offset where changes line up -----
  const scores = [];
  for (let o = 0; o < PHRASE; o++) {
    let s = 0, c = 0;
    for (let i = o; i < nb; i += PHRASE) if (i >= WIN && i <= nb - WIN) { s += nov[i]; c++; }
    scores.push(c ? s / c : 0);
  }
  const phraseOffset = scores.indexOf(Math.max(...scores));
  const meanS = scores.reduce((a, b) => a + b, 0) / PHRASE;
  const sdS = Math.sqrt(scores.reduce((a, b) => a + (b - meanS) ** 2, 0) / PHRASE) || 1e-9;
  const phraseConfidence = (scores[phraseOffset] - meanS) / sdS;

  // ----- 8-bar windows on the phrase grid, and how exactly each one repeats -----
  const wins = [];
  for (let a = phraseOffset; a + PHRASE <= nb; a += PHRASE) wins.push(a);
  const nw = wins.length;
  const diag = (a, b) => { let s = 0; for (let j = 0; j < PHRASE; j++) s += sim(a + j, b + j); return s / PHRASE; };
  const D = wins.map((a) => wins.map((b) => (a === b ? 0 : diag(a, b))));
  const wEnergy = wins.map((a) => { let s = 0; for (let j = 0; j < PHRASE; j++) s += energy[a + j]; return s / PHRASE; });
  const offDiag = D.flatMap((row, i) => row.filter((_, j) => j !== i));
  const dMed = median(offDiag);

  // Hook: start from the most alike pair of loud windows, then gather every window that
  // matches that pair about as closely.
  let hookSet = new Set(), hookStrength = 0;
  if (nw >= 3) {
    let best = null;
    for (let i = 0; i < nw; i++) for (let j = i + 1; j < nw; j++) {
      if (wEnergy[i] < 0.8 * eMed || wEnergy[j] < 0.8 * eMed) continue;
      if (!best || D[i][j] > best.v) best = { i, j, v: D[i][j] };
    }
    if (best) {
      const spread = Math.max(1e-6, best.v - dMed);
      const thr = best.v - 0.4 * spread;
      hookSet = new Set([best.i, best.j]);
      for (let k = 0; k < nw; k++) {
        if (hookSet.has(k) || wEnergy[k] < 0.7 * eMed) continue;
        if (D[k][best.i] >= thr && D[k][best.j] >= thr) hookSet.add(k);
      }
      // a hook is a minority of the song; if nearly everything matched, the song is one loop
      if (hookSet.size > Math.max(2, nw * 0.6)) hookSet = new Set([best.i, best.j]);
      const sdOff = Math.sqrt(offDiag.reduce((s, v) => s + (v - dMed) ** 2, 0) / offDiag.length) || 1e-9;
      hookStrength = spread / sdOff;
    }
  }

  // ----- sections -----
  const firstLoud = (() => { for (let b = 0; b < nb; b++) if (loudBar(b)) return b; return 0; })();
  const lastLoud = (() => { for (let b = nb - 1; b >= 0; b--) if (loudBar(b)) return b; return nb - 1; })();
  const firstHook = Math.min(...[...hookSet], Infinity), lastHook = Math.max(...[...hookSet], -Infinity);
  const labels = wins.map((_, k) => {
    if (hookSet.has(k)) return 'Hook';
    if (wEnergy[k] < 0.6 * eMed) return k < firstHook ? 'Intro' : k > lastHook ? 'Outro' : 'Break';
    if (k === 0 && wEnergy[k] < 0.85 * eMed) return 'Intro';
    if (k === nw - 1 && k > lastHook && wEnergy[k] < 0.85 * eMed) return 'Outro';
    return 'Verse';
  });
  const at = (bar) => downbeat + bar * barLen;
  const sections = [];
  const push = (label, b0, b1) => {
    if (b1 <= b0) return;
    const prev = sections[sections.length - 1];
    if (prev && prev.label === label) prev.end = at(b1);
    else sections.push({ label, start: at(b0), end: at(b1) });
  };
  if (phraseOffset > firstLoud) push(wins.length && labels[0] === 'Intro' ? 'Intro' : 'Intro', firstLoud, Math.min(phraseOffset, nb));
  wins.forEach((a, k) => push(labels[k], Math.max(a, firstLoud), Math.min(a + PHRASE, lastLoud + 1)));
  const tailFrom = nw ? wins[nw - 1] + PHRASE : phraseOffset;
  if (lastLoud + 1 > tailFrom) push('Outro', tailFrom, lastLoud + 1);
  // the very first and last sections need a little leeway for partial bars
  if (sections.length) sections[sections.length - 1].end = Math.min(duration, sections[sections.length - 1].end);

  // ----- drop: the biggest lift in loudness at a phrase start -----
  let drop = null, lift = 1.45;
  wins.forEach((a, k) => {
    if (a < WIN || a + WIN > nb) return;
    let pre = 0, post = 0;
    for (let j = 0; j < WIN; j++) { pre += energy[a - WIN + j]; post += energy[a + j]; }
    const r = post / Math.max(pre, 1e-6);
    if (r > lift && wEnergy[k] >= 0.8 * eMed) { lift = r; drop = at(a); }
  });

  const hooks = [...hookSet].sort((a, b) => a - b).map((k) => at(wins[k]));
  return {
    downbeat, barLen, phraseBars: PHRASE, phraseOffset,
    phraseConfidence: Math.round(phraseConfidence * 100) / 100,
    hookStrength: Math.round(hookStrength * 100) / 100,
    hook: hooks[0] ?? null, hooks, drop,
    sections: sections.map((s) => ({ label: s.label, start: Math.round(s.start * 1000) / 1000, end: Math.round(s.end * 1000) / 1000 })),
  };
}

// Hot cues set automatically for a song nobody has cued yet:
// 1 start of the music, 2 first hook, 3 the drop (or the second hook), 4 the outro.
export function autoCues(st, soundStart = 0) {
  if (!st) return null;
  const cues = new Array(8).fill(null);
  const first = st.sections[0];
  cues[0] = Math.max(soundStart, first ? first.start : 0);
  if (st.hook != null) cues[1] = st.hook;
  const third = st.drop != null && (st.hook == null || Math.abs(st.drop - st.hook) > st.barLen * 6) ? st.drop : st.hooks[1];
  if (third != null) cues[2] = third;
  const outro = [...st.sections].reverse().find((s) => s.label === 'Outro');
  if (outro) cues[3] = outro.start;
  return cues.map((c) => (c == null ? null : Math.round(c * 1000) / 1000));
}
