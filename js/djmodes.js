// Auto DJ modes: how long each song plays, where it comes in, and which moves are used.
// Pure functions (no browser APIs) so they can be unit-tested.
import { blendable, mashupFit } from './setplan.js';

export const MODES = {
  nightclub: {
    name: 'Nightclub',
    blurb: 'About 15 to 20 seconds of each song, straight to the hooks, with cuts, spinbacks, brakes, chops and teases. Drums drive every change.',
    seconds: [14, 21], target: 17, snap: 4, entry: 'hot', order: 'smart', energy: 'high',
    moves: { cut: 3, spinback: 2, brake: 1.5, chop: 2, tease: 2.5, hiphop: 1.2, quick2: 1.5 },
    quickFire: 4,          // every 4th change is a quick-fire run (flips every bar)
    runItBack: 0.25,       // share of songs that get rewound once
    drums: true, fx: 'club', handover: 'bars',
  },
  mixshow: {
    name: 'Mixshow',
    blurb: 'Radio mixshow style: about a minute per song, hook to hook, every change a tight blend on the beat.',
    seconds: [42, 66], target: 52, snap: 8, entry: 'hook', order: 'smart', energy: null,
    moves: { quick4: 4, quick2: 2, hiphop: 1 },
    drums: false, fx: false, handover: 'bars',
  },
  party: {
    name: 'Peak-time party',
    blurb: 'About a minute and a half to two minutes per song, energy building through the set, big drops with blends and club moves.',
    seconds: [85, 125], target: 105, snap: 8, entry: 'start', order: 'smart', energy: 'rise',
    moves: { pop: 4, cut: 2, spinback: 1, hiphop: 1.5, tease: 1 },
    runItBack: 0.1,
    drums: true, fx: 'party', handover: 'bars',
  },
  lounge: {
    name: 'Lounge / warm-up',
    blurb: 'For early in the night: longer plays, long smooth blends, calmer songs first. No tricks.',
    seconds: [150, 200], target: 175, snap: 8, entry: 'start', order: 'smart', energy: 'rise',
    moves: { house: 4, pop: 1 },
    drums: false, fx: false, handover: 'outro',
  },
};
export const MODE_IDS = ['nightclub', 'mixshow', 'party', 'lounge'];

// How many bars a song plays for in a mode, given its bar length in seconds: the whole
// number of phrase pieces (4 or 8 bars) closest to the mode's target, kept musical rather
// than exact (at 84 BPM, 4 bars is 11 s and 8 bars is 23 s).
export function playBars(mode, barSec) {
  const m = MODES[mode];
  if (!m || !(barSec > 0)) return 8;
  let best = m.snap, gap = Infinity;
  for (let n = m.snap; n <= 128; n += m.snap) {
    const d = Math.abs(n * barSec - m.target);
    if (d < gap) { gap = d; best = n; }
  }
  return best;
}

// Moves that need the two songs at about the same tempo.
const NEEDS_SYNC = new Set(['tease', 'teasefire', 'quick2', 'quick4', 'pop', 'house']);

// Picks the move from song a into song b. a and b: { bpm, camelot, stems }.
// history: moves used so far (latest last). Never repeats the previous move.
export function chooseMove(a, b, mode, history = [], rng = Math.random) {
  const m = MODES[mode];
  if (!m) return 'pop';
  const n = history.length;
  const synced = blendable(a.bpm, b.bpm, mode === 'nightclub' ? 0.08 : 0.1);
  if (m.quickFire && (n + 1) % m.quickFire === 0 && synced) return 'teasefire';
  const options = Object.entries(m.moves).filter(([id]) => (synced || !NEEDS_SYNC.has(id)) && id !== history[n - 1]);
  if (b.stems === 1 && mashupFit(a, b) && mode !== 'lounge' && history[n - 1] !== 'mashup') options.push(['mashup', 1.5]);
  if (!options.length) return synced ? Object.keys(m.moves)[0] : mode === 'lounge' || mode === 'mixshow' ? 'rnb' : 'cut';
  const total = options.reduce((s, [, w]) => s + w, 0);
  let x = rng() * total;
  for (const [id, w] of options) { x -= w; if (x <= 0) return id; }
  return options[options.length - 1][0];
}
