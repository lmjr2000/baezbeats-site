// Plans a DJ set: what order to play songs in and how to move between each pair.
// Pure functions (no browser APIs) so they can be unit-tested.

export function camelot(code) {
  const m = /^(\d{1,2})([AB])$/.exec(code || '');
  return m ? { n: Number(m[1]), l: m[2] } : null;
}

// 0 = keys sit well together, 1 = likely to clash. Camelot wheel rules: same key,
// one step round the wheel, or the relative major / minor.
export function keyCost(a, b) {
  const x = camelot(a), y = camelot(b);
  if (!x || !y) return 0.5;
  const step = Math.min((x.n - y.n + 12) % 12, (y.n - x.n + 12) % 12);
  if (x.l === y.l) return step === 0 ? 0 : step === 1 ? 0.1 : step === 2 ? 0.6 : 1;
  return step === 0 ? 0.1 : step === 1 ? 0.5 : 1;
}

// How much song b must be sped up (>1) or slowed (<1) to match a. Half / double time counts as a match.
export function tempoRatio(a, b) {
  if (!(a > 0) || !(b > 0)) return 0;
  let r = a / b;
  while (r > 1.42) r /= 2;
  while (r < 0.71) r *= 2;
  return r;
}
export const blendable = (a, b, limit = 0.08) => {
  const r = tempoRatio(a, b);
  return r > 0 && Math.abs(r - 1) <= limit;
};

const norm = (s) => (s || '').toLowerCase().replace(/\(.*?\)|\[.*?\]/g, '').replace(/[^a-z0-9]+/g, ' ').trim();
const songKey = (t) => `${norm(t.artist)}|${norm(t.title)}`;

// How hard a song hits, 0 (calm) to 1 (peak time): mostly loudness, plus how fast it
// feels (half-time trap at 140 feels like 70) and how strong its hook is.
export function energyOf(t) {
  const loud = t.loud == null ? 0.5 : Math.min(1, Math.max(0, (t.loud + 18) / 15));
  let feel = t.bpm || 100;
  const beats = t.snare_period && t.bpm ? Math.round(t.snare_period / (60 / t.bpm)) : 2;
  if (beats >= 4) feel /= 2;                                // snare once a bar: half-time
  const speed = Math.min(1, Math.max(0, (feel - 65) / 70));
  const hook = Math.min(1, (t.structure?.hookStrength || 1) / 3);
  return 0.6 * loud + 0.25 * speed + 0.15 * hook;
}

// Lower is a better follow-on from a to b.
export function pairCost(a, b) {
  const r = tempoRatio(a.bpm, b.bpm);
  const tempo = r ? Math.min(1, Math.abs(Math.log2(r)) / Math.log2(1.2)) : 0.8;
  const artist = norm(a.artist) && norm(a.artist) === norm(b.artist) ? 0.25 : 0;
  return 2 * tempo + keyCost(a.camelot, b.camelot) + artist;
}

// How to get from a to b. `count` (transitions so far) is used to vary the moves.
// a and b may carry `stems: 1` (prepared stems) and `camelot`; a mashup needs b's stems.
export function chooseStyle(a, b, count = 0) {
  if (b.stems === 1 && count % 3 === 1 && mashupFit(a, b)) return 'mashup';
  if (blendable(a.bpm, b.bpm)) return count % 4 === 3 ? 'hiphop' : 'pop';
  return count % 2 ? 'rnb' : 'hiphop';
}
export const STYLE_LABEL = {
  pop: 'Blend', house: 'Long blend', hiphop: 'Loop roll and drop', rnb: 'Echo out', mashup: 'Mashup',
  cut: 'Cut', spinback: 'Spinback', brake: 'Brake', chop: 'Chop', tease: 'Tease', teasefire: 'Quick-fire',
  quick2: 'Quick blend', quick4: 'Quick blend', runback: 'Run it back',
};

// order: 'smart' (tempo and key), 'listed' (as given) or 'shuffle'.
// Returns { queue, skipped } where skipped counts alternate versions of a song left out.
// energy: 'rise' (build through the set), 'high' (start at the top and stay there), or none.
export function planSet(tracks, { order = 'smart', startId = null, rng = Math.random, energy = null } = {}) {
  let pool = tracks.filter((t) => t && t.duration > 20);
  let skipped = 0;
  if (order !== 'listed') {
    // keep one version of each song (the longest), unless the list is tiny
    const seen = new Map();
    for (const t of pool) {
      const k = songKey(t);
      const cur = seen.get(k);
      if (!cur) seen.set(k, t);
      else { skipped++; if (t.id === startId || (cur.id !== startId && t.duration > cur.duration)) seen.set(k, t); }
    }
    pool = [...seen.values()];
  }
  const first = pool.find((t) => t.id === startId);
  if (order === 'listed') {
    if (!first) return { queue: pool, skipped };
    const i = pool.indexOf(first);
    return { queue: [...pool.slice(i), ...pool.slice(0, i)], skipped };
  }
  if (order === 'shuffle') {
    const rest = pool.filter((t) => t !== first);
    for (let i = rest.length - 1; i > 0; i--) { const j = Math.floor(rng() * (i + 1)); [rest[i], rest[j]] = [rest[j], rest[i]]; }
    return { queue: first ? [first, ...rest] : rest, skipped };
  }
  // smart: start from the given song (or the slowest one, so the set builds), then keep
  // taking the best follow-on that has not been played
  const rest = new Set(pool);
  const byEnergy = (dir) => pool.filter((t) => t.bpm > 0).sort((a, b) => dir * (energyOf(a) - energyOf(b)))[0];
  let cur = first || (energy === 'rise' ? byEnergy(1) : energy === 'high' ? byEnergy(-1) : null)
    || pool.filter((t) => t.bpm > 0).sort((a, b) => a.bpm - b.bpm)[0] || pool[0];
  const queue = [];
  while (cur) {
    queue.push(cur); rest.delete(cur);
    let best = null, bestCost = Infinity;
    for (const t of rest) {
      let c = pairCost(cur, t);
      if (energy === 'rise') c += 2.5 * Math.max(0, energyOf(cur) - energyOf(t));   // avoid dropping the energy
      if (energy === 'high') c += 1.5 * (1 - energyOf(t));                          // keep it hot
      if (c < bestCost) { best = t; bestCost = c; }
    }
    cur = best;
  }
  return { queue, skipped };
}

// Camelot code after shifting the key by some semitones (one semitone = 7 steps round the wheel).
export function shiftCamelot(code, semis) {
  const c = camelot(code);
  if (!c) return '';
  return `${(((c.n - 1 + 7 * semis) % 12) + 12) % 12 + 1}${c.l}`;
}

// Smallest key shift (within ±2 semitones, so vocals still sound natural) that puts the
// incoming key in harmony with the outgoing one. null when no small shift works.
export function mashupShift(fromCode, toCode) {
  if (!camelot(fromCode) || !camelot(toCode)) return null;
  for (const s of [0, 1, -1, 2, -2]) if (keyCost(fromCode, shiftCamelot(toCode, s)) <= 0.1) return s;
  return null;
}

// Can b's vocals go over a's beat? Tempo within 6% and a small key shift.
export function mashupFit(a, b) {
  if (!blendable(a.bpm, b.bpm, 0.06)) return null;
  const shift = mashupShift(a.camelot, b.camelot);
  if (shift == null) return null;
  const r = tempoRatio(a.bpm, b.bpm);
  return { shift, tempoChange: r - 1, score: Math.abs(r - 1) * 10 + Math.abs(shift) * 0.4 };
}
