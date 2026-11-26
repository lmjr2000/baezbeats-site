// Track analysis: tempo + beatgrid, musical key, and 3-band waveform peaks.
// Pure JS on a mono Float32Array so it can be unit-tested without ffmpeg.

import { fft, hann } from './dsp.js';
import { detectStructure } from './structure.js';

export const ANALYSIS_RATE = 22050;
const PEAK_HOP = 210; // 105 waveform points per second

// ---------- waveform peaks ----------
// Three bytes per point: peak level of the low / mid / high band.
export function computePeaks(x, sr) {
  const n = Math.floor(x.length / PEAK_HOP);
  const peaks = new Uint8Array(n * 3);
  const aLow = 1 - Math.exp((-2 * Math.PI * 180) / sr);
  const aHigh = 1 - Math.exp((-2 * Math.PI * 2500) / sr);
  let l1 = 0, l2 = 0, h1 = 0, h2 = 0;
  for (let p = 0; p < n; p++) {
    let ml = 0, mm = 0, mh = 0;
    const start = p * PEAK_HOP;
    for (let i = start; i < start + PEAK_HOP; i++) {
      const s = x[i];
      l1 += aLow * (s - l1); l2 += aLow * (l1 - l2);
      h1 += aHigh * (s - h1); h2 += aHigh * (h1 - h2);
      const low = Math.abs(l2), mid = Math.abs(h2 - l2), high = Math.abs(s - h2);
      if (low > ml) ml = low;
      if (mid > mm) mm = mid;
      if (high > mh) mh = high;
    }
    peaks[p * 3] = Math.min(255, ml * 255);
    peaks[p * 3 + 1] = Math.min(255, mm * 255);
    peaks[p * 3 + 2] = Math.min(255, mh * 255 * 1.5);
  }
  return { peaks, peaksRate: sr / PEAK_HOP };
}

// ---------- tempo ----------
const ONSET_N = 1024, ONSET_HOP = 256;
// Measured with click tracks (test/analysis.test.js): seconds to add to a flux-frame time
// to get the onset time.
const ONSET_LATENCY = 0.027;
const LOW_BINS = Math.round((250 * ONSET_N) / ANALYSIS_RATE);
const MID_LO = Math.round((350 * ONSET_N) / ANALYSIS_RATE), MID_HI = Math.round((4500 * ONSET_N) / ANALYSIS_RATE);

function detrend(env) {
  // Remove the slow-moving average so only sharp rises remain, then scale to mean 1.
  const frames = env.length;
  const out = new Float32Array(frames);
  const R = 17;
  let sum = 0, total = 0;
  for (let i = 0; i < Math.min(R, frames); i++) sum += env[i];
  for (let i = 0; i < frames; i++) {
    const lo = i - R - 1, hi = i + R;
    if (hi < frames) sum += env[hi];
    if (lo >= 0) sum -= env[lo];
    const cnt = Math.min(frames - 1, hi) - Math.max(0, lo + 1) + 1;
    out[i] = Math.max(0, env[i] - sum / cnt);
    total += out[i];
  }
  if (total > 0) { const k = frames / total; for (let i = 0; i < frames; i++) out[i] *= k; }
  return out;
}

// Spectral-flux onset curve. Half the weight goes to the bass band so the grid
// locks to kicks rather than to off-beat hi-hats.
export function onsetEnvelope(x) {
  const frames = Math.max(0, Math.floor((x.length - ONSET_N) / ONSET_HOP));
  const all = new Float32Array(frames), low = new Float32Array(frames), mid = new Float32Array(frames);
  const win = hann(ONSET_N);
  const re = new Float32Array(ONSET_N), im = new Float32Array(ONSET_N);
  const half = ONSET_N / 2;
  let prev = new Float32Array(half), cur = new Float32Array(half);
  let prevLow = 0, prevMid = 0;
  for (let f = 0; f < frames; f++) {
    const o = f * ONSET_HOP;
    for (let i = 0; i < ONSET_N; i++) { re[i] = x[o + i] * win[i]; im[i] = 0; }
    fft(re, im);
    let flux = 0, lowMag = 0, midMag = 0;
    for (let k = 1; k < half; k++) {
      const mag = Math.hypot(re[k], im[k]);
      const m = Math.log1p(100 * mag);
      cur[k] = m;
      const d = m - prev[k];
      if (d > 0) flux += d;
      if (k <= LOW_BINS) lowMag += mag;
      else if (k >= MID_LO && k <= MID_HI) midMag += mag;
    }
    all[f] = flux; low[f] = Math.max(0, lowMag - prevLow); prevLow = lowMag;
    mid[f] = Math.max(0, midMag - prevMid); prevMid = midMag;
    const t = prev; prev = cur; cur = t;
  }
  const a = detrend(all), b = detrend(low);
  for (let i = 0; i < frames; i++) a[i] += 2 * b[i];
  a.mid = detrend(mid);   // snare / clap band, used to find the backbeat
  return a;
}

// ---------- backbeat ----------
// Finds the snare / clap pattern: the steadiest thing in hip-hop, trap and pop, and what
// a DJ lines up by ear. Starts from a slow lattice (every 8 beats) and halves it while
// the slots in between are also hit. Returns the period and the first hit, in frames.
export function findBackbeat(mid, P) {
  const n = mid.length;
  const soft = new Float32Array(n);
  for (let i = 1; i < n - 1; i++) soft[i] = 0.25 * mid[i - 1] + 0.5 * mid[i] + 0.25 * mid[i + 1];
  const at = (start, period) => {
    let sum = 0, c = 0;
    for (let t = start; t < n - 1; t += period) {
      if (t < 0) continue;
      const i = t | 0, fr = t - i;
      sum += soft[i] + (soft[i + 1] - soft[i]) * fr; c++;
    }
    return c ? sum / c : 0;
  };
  let period = 8 * P, best = { score: -1, phase: 0 };
  for (let phase = 0; phase < period; phase += 0.5) {
    const sc = at(phase, period);
    if (sc > best.score) best = { score: sc, phase };
  }
  let { phase, score } = best;
  while (period > P * 1.01) {
    const between = at(phase + period / 2, period);
    if (between < 0.7 * score) break;
    period /= 2;
    phase %= period;
    score = at(phase, period);
  }
  let mean = 0;
  for (let i = 0; i < n; i++) mean += soft[i];
  mean = mean / n || 1;
  return { period, phase, contrast: score / mean };
}

// Autocorrelation of the envelope at a fractional lag.
export function acf(env, lag) {
  const n = env.length - Math.ceil(lag) - 1;
  if (n <= 0) return 0;
  const i0 = lag | 0, fr = lag - i0;
  let s = 0;
  for (let i = 0; i < n; i++) s += env[i] * (env[i + i0] + (env[i + i0 + 1] - env[i + i0]) * fr);
  return s / n;
}

// Mean envelope value at beat positions for a period (in frames), best phase.
export function combScore(env, period, phaseStep, withOffbeat) {
  const n = env.length;
  let best = -Infinity, bestPhase = 0, bestOn = 0;
  for (let phase = 0; phase < period; phase += phaseStep) {
    let on = 0, off = 0, c = 0;
    for (let t = phase; t < n - 1; t += period) {
      const i = t | 0, fr = t - i;
      on += env[i] + (env[i + 1] - env[i]) * fr;
      if (withOffbeat) {
        const u = t + period / 2;
        if (u < n - 1) { const j = u | 0; off += env[j] + (env[j + 1] - env[j]) * (u - j); }
      }
      c++;
    }
    if (!c) continue;
    const s = (on - off) / c;
    if (s > best) { best = s; bestPhase = phase; bestOn = on / c; }
  }
  return { score: best, phase: bestPhase, on: bestOn };
}

export function detectTempo(x, sr = ANALYSIS_RATE) {
  const env = onsetEnvelope(x);
  const fps = sr / ONSET_HOP;
  if (env.length < fps * 4) return { bpm: 0, firstBeat: 0, snarePeriod: 0, snareFirst: 0 };
  let total = 0;
  for (let i = 0; i < env.length; i++) total += env[i];
  if (total <= 0) return { bpm: 0, firstBeat: 0, snarePeriod: 0, snareFirst: 0 };

  // Coarse pass. Real music repeats by the bar, so score each tempo by how alike the
  // onset curve is 1, 2, 4, 8 and 16 beats apart. Triplet hi-hats and syncopated 808s
  // (trap, drill) make a tempo two-thirds or one-and-a-half times the real one look
  // good a beat apart, but those tempos do not line up bar after bar.
  // (blurred copy, so whole-frame lags are not favoured over fractional ones)
  const soft = new Float32Array(env.length);
  for (let i = 2; i < env.length - 2; i++) {
    soft[i] = (env[i - 2] + 2 * env[i - 1] + 3 * env[i] + 2 * env[i + 1] + env[i + 2]) / 9;
  }
  const raw = (bpm) => {
    const P = (fps * 60) / bpm;
    let sum = 0, n = 0;
    for (const k of [1, 2, 4, 8, 16]) {
      if (k * P > env.length / 2) break;
      sum += acf(soft, k * P); n++;
    }
    return n ? sum / n : 0;
  };
  const peakNear = (centre, span, step) => {
    let top = { bpm: centre, score: -1 };
    for (let bpm = centre - span; bpm <= centre + span; bpm += step) {
      const sc = raw(bpm);
      if (sc > top.score) top = { bpm, score: sc };
    }
    return top;
  };
  let best = { bpm: 0, score: -1 };
  for (let bpm = 55; bpm <= 210; bpm += 0.1) {
    const sc = raw(bpm);
    if (sc > best.score) best = { bpm, score: sc };
  }
  // Half and double tempo fit the bars equally well. Settle the octave with a gentle
  // preference for 85-170 BPM and for whole numbers (producers set whole BPMs).
  const prior = (bpm) => Math.exp(-0.5 * (Math.log2(bpm / 120) / 0.55) ** 2);
  let pick = null;
  for (const f of [0.25, 0.5, 1, 2, 4]) {
    const c = best.bpm * f;
    if (c < 60 || c > 200) continue;
    const top = peakNear(c, 0.3, 0.02);
    const whole = Math.abs(top.bpm - Math.round(top.bpm)) < 0.08 ? 1.08 : 1;
    const w = top.score * prior(top.bpm) * whole;
    if (!pick || w > pick.w) pick = { ...top, w };
  }
  best = pick || best;

  // Fine pass around the winner.
  let fine = { on: -Infinity, bpm: best.bpm, phase: 0 };
  for (let bpm = best.bpm - 0.5; bpm <= best.bpm + 0.5; bpm += 0.01) {
    const r = combScore(env, (fps * 60) / bpm, 0.5, false);
    if (r.on > fine.on) fine = { on: r.on, bpm, phase: r.phase };
  }
  // Most produced music sits on a whole BPM; take it when it fits nearly as well.
  const whole = Math.round(fine.bpm);
  if (Math.abs(whole - fine.bpm) < 0.06) {
    const r = combScore(env, (fps * 60) / whole, 0.25, false);
    if (r.on >= fine.on * 0.97) fine = { on: r.on, bpm: whole, phase: r.phase };
  } else {
    fine = { ...fine, ...combScore(env, (fps * 60) / fine.bpm, 0.25, false) };
  }
  const bpm = Math.round(fine.bpm * 100) / 100;
  const beat = 60 / bpm;
  let firstBeat = fine.phase / fps + ONSET_LATENCY;
  firstBeat -= Math.floor(firstBeat / beat) * beat;

  // Backbeat (snare / clap). When it is clear, it also corrects the beat grid: on
  // syncopated tracks the strongest onsets can sit half a beat away from the real beat.
  let snarePeriod = 0, snareFirst = 0;
  if (env.mid) {
    const bb = findBackbeat(env.mid, (fps * 60) / bpm);
    if (bb.contrast >= 4) {
      snarePeriod = Math.round(bb.period / ((fps * 60) / bpm)) * beat;
      snareFirst = bb.phase / fps + ONSET_LATENCY;
      snareFirst -= Math.floor(snareFirst / snarePeriod) * snarePeriod;
      firstBeat = snareFirst - Math.floor(snareFirst / beat) * beat;
    }
  }
  return { bpm, firstBeat, snarePeriod, snareFirst };
}

// ---------- key ----------
const KEY_N = 8192, KEY_HOP = 4096;
const MAJOR = [6.6, 2.0, 3.5, 2.3, 4.6, 4.0, 2.5, 5.2, 2.4, 3.7, 2.3, 3.4];
const MINOR = [6.5, 2.7, 3.5, 5.4, 2.6, 3.5, 2.5, 5.2, 4.0, 2.7, 4.3, 3.2];
const NAMES = ['C', 'Db', 'D', 'Eb', 'E', 'F', 'F#', 'G', 'Ab', 'A', 'Bb', 'B'];
const CAMELOT_MAJOR = [8, 3, 10, 5, 12, 7, 2, 9, 4, 11, 6, 1];
const CAMELOT_MINOR = [5, 12, 7, 2, 9, 4, 11, 6, 1, 8, 3, 10];

function correlate(a, b, shift) {
  let ma = 0, mb = 0;
  for (let i = 0; i < 12; i++) { ma += a[i]; mb += b[i]; }
  ma /= 12; mb /= 12;
  let num = 0, da = 0, dbb = 0;
  for (let i = 0; i < 12; i++) {
    const x = a[(i + shift) % 12] - ma, y = b[i] - mb;
    num += x * y; da += x * x; dbb += y * y;
  }
  return num / (Math.sqrt(da * dbb) || 1);
}

export function detectKey(x, sr = ANALYSIS_RATE) {
  const chroma = new Float64Array(12);
  const win = hann(KEY_N);
  const re = new Float32Array(KEY_N), im = new Float32Array(KEY_N);
  const mag = new Float32Array(KEY_N / 2);
  const kLo = Math.ceil((65 * KEY_N) / sr), kHi = Math.floor((2000 * KEY_N) / sr);
  // Per-bin pitch class and how close the bin is to the centre of a semitone.
  const pc = new Int8Array(kHi + 1), wt = new Float32Array(kHi + 1);
  for (let k = kLo; k <= kHi; k++) {
    const midi = 69 + 12 * Math.log2((k * sr) / KEY_N / 440);
    const near = Math.round(midi);
    pc[k] = ((near % 12) + 12) % 12;
    wt[k] = Math.cos((midi - near) * Math.PI) ** 2;
  }
  for (let o = 0; o + KEY_N <= x.length; o += KEY_HOP) {
    for (let i = 0; i < KEY_N; i++) { re[i] = x[o + i] * win[i]; im[i] = 0; }
    fft(re, im);
    for (let k = kLo - 1; k <= kHi + 1; k++) mag[k] = Math.hypot(re[k], im[k]);
    const frame = new Float64Array(12);
    let sum = 0;
    for (let k = kLo; k <= kHi; k++) {
      if (mag[k] > mag[k - 1] && mag[k] >= mag[k + 1]) { // spectral peaks only
        const v = mag[k] * wt[k];
        frame[pc[k]] += v; sum += v;
      }
    }
    if (sum > 1e-3) for (let i = 0; i < 12; i++) chroma[i] += frame[i] / sum;
  }
  let best = { r: -Infinity, tonic: 0, minor: false };
  for (let tonic = 0; tonic < 12; tonic++) {
    const rM = correlate(chroma, MAJOR, tonic);
    const rm = correlate(chroma, MINOR, tonic);
    if (rM > best.r) best = { r: rM, tonic, minor: false };
    if (rm > best.r) best = { r: rm, tonic, minor: true };
  }
  if (!Number.isFinite(best.r) || chroma.every((v) => v === 0)) return { key: '', camelot: '' };
  return {
    key: NAMES[best.tonic] + (best.minor ? 'm' : ''),
    camelot: best.minor ? `${CAMELOT_MINOR[best.tonic]}A` : `${CAMELOT_MAJOR[best.tonic]}B`,
  };
}

// ---------- loudness ----------
// RMS level (dBFS) of the louder half of the track, so quiet intros do not skew it.
// Used to set each deck's gain so songs from different sources play at a similar level.
export function loudness(x, sr = ANALYSIS_RATE) {
  const win = Math.floor(sr * 0.4);
  const levels = [];
  for (let o = 0; o + win <= x.length; o += win) {
    let sum = 0;
    for (let i = o; i < o + win; i++) sum += x[i] * x[i];
    levels.push(sum / win);
  }
  if (!levels.length) return null;
  levels.sort((a, b) => b - a);
  const top = levels.slice(0, Math.max(1, Math.floor(levels.length / 2)));
  const mean = top.reduce((a, b) => a + b, 0) / top.length;
  return mean > 0 ? 10 * Math.log10(mean) : null;
}

// Bump when the analysis changes, so existing libraries are analysed again.
export const ANALYSIS_VERSION = 3;

export function analyze(x, sr = ANALYSIS_RATE) {
  const tempo = detectTempo(x, sr);
  let structure = null;
  try { structure = detectStructure(x, sr, tempo); } catch (e) { console.warn('structure analysis failed:', e.message); }
  return { ...tempo, ...detectKey(x, sr), ...computePeaks(x, sr), loud: loudness(x, sr), structure };
}
