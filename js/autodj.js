// Auto DJ: plays a whole set on its own, in one of four modes (see djmodes.js):
//   Nightclub   15-20 s of each song, hooks only, cuts / spinbacks / brakes / chops / teases,
//               the drums driving every change, now and then a "run it back"
//   Mixshow     about a minute per song, hook to hook, tight blends on the beat
//   Peak-time   1.5-2 min per song, energy building, drops with blends and club moves
//   Lounge      long plays, long smooth blends, calm songs first
//   Custom      the order and play length chosen by hand
// It plans the running order, picks a move for every change, loads the next song ahead of
// time, works out the exact bar each song hands over on, and runs the move with the same
// engine as AI mix (automix.js).
import { h, fill, fmtTime, toast } from './controls.js';
import { planSet, chooseStyle, STYLE_LABEL, blendable } from './setplan.js';
import { MODES, MODE_IDS, playBars, chooseMove } from './djmodes.js';
import { api } from './api.js';

const LENGTHS = [[0, 'Full songs'], [150, 'About 2½ minutes each, from the hook'], [105, 'About 1¾ minutes each, from the hook'], [70, 'About 1 minute each, from the hook']];
const ORDERS = [['smart', 'Smart order (tempo and key)'], ['listed', 'In the order listed'], ['shuffle', 'Shuffle']];

export function buildAutoDJ(decks, automix, library, showTab) {
  const saved = JSON.parse(localStorage.getItem('baezbeats.autodj') || '{}');
  const opts = {
    mode: saved.mode && (MODES[saved.mode] || saved.mode === 'custom') ? saved.mode : 'nightclub',
    order: saved.order || 'smart', maxPlay: saved.maxPlay ?? 0, repeat: saved.repeat ?? true, fx: saved.fx ?? true,
  };
  const save = () => localStorage.setItem('baezbeats.autodj', JSON.stringify(opts));
  const M = () => MODES[opts.mode] || null;                    // null for Custom

  let running = false;
  let queue = [];            // songs still to come
  let played = [];           // songs already played this session
  let source = '';           // name of the list the set was built from
  let skipped = 0;
  let history = [];          // moves used so far (so the same one is not used twice running)
  let planned = new Map();   // track id -> the move it comes in with
  let rewinds = new Set();   // track ids that get a "run it back"
  let startedAt = null;      // { id, pos, bars, rewound } for the song playing now
  let mixing = false, skipNow = false, timer = null;
  const warmed = new Set();  // songs whose analysis was asked for early
  const listeners = new Set();

  const current = () => decks.find((d) => d.playing && d.track) || null;
  const info = (d) => ({ bpm: d.effectiveBpm, artist: d.track.artist, camelot: d.keyCamelot, stems: d.track.stems });

  // ---------- planning ----------
  // Works out the move for every change in the queue, and which songs get run back.
  function planMoves() {
    planned = new Map(); rewinds = new Set();
    const cur = current();
    let prev = cur ? info(cur) : null;
    const hist = history.slice();
    const m = M();
    for (const t of queue) {
      if (prev) {
        const move = m ? chooseMove(prev, t, opts.mode, hist) : chooseStyle(prev, t, hist.length);
        planned.set(t.id, move); hist.push(move);
      }
      if (m?.runItBack && Math.random() < m.runItBack) rewinds.add(t.id);
      prev = t;
    }
  }
  const styleFor = (cur, next) => planned.get(next.id) || (M() ? chooseMove(info(cur), next, opts.mode, history) : chooseStyle(info(cur), next, history.length));
  const entryFor = (m) => (m ? (opts.mode === 'party' && Math.random() < 0.4 ? 'hook' : m.entry) : opts.maxPlay ? 'hook' : 'start');

  // The bar the current song came in on, snapped to its grid.
  function entryBar(cur) {
    const g = cur.grid;
    if (!g || !startedAt) return cur.pos;
    return g.downbeat + Math.round((startedAt.pos - g.downbeat) / g.bar) * g.bar;
  }

  // The bar the current song hands over on (source seconds). In the club-style modes that is
  // the bar it came in on plus the mode's number of bars; in Lounge and Custom it is the
  // last phrase before the song's outro (or its play time running out).
  function mixMoment(cur, next) {
    if (!cur || !next) return null;
    const m = M();
    const sh = automix.shape(styleFor(cur, next), cur);
    const bar = cur.grid ? cur.grid.bar : cur.beatLen * 4;
    let S;
    if (m && m.handover === 'bars' && cur.grid) {
      const n = startedAt?.bars ?? playBars(opts.mode, bar / cur.rate);
      const E = entryBar(cur);
      S = E + n * bar;
      // a song that ends sooner hands over on its last whole bar before the outro
      if (S + sh.after > cur.mixOutPoint) S = E + Math.max(1, Math.floor((cur.mixOutPoint - sh.after - E) / bar)) * bar;
    } else {
      let out = cur.mixOutPoint;
      const cap = m ? m.seconds[1] : opts.maxPlay;
      if (cap && startedAt?.id === cur.track.id) out = Math.min(out, startedAt.pos + cap * cur.rate);
      S = cur.phraseAtOrBefore(out - sh.after);
    }
    // too late for that bar: take the next one that still leaves room for the move
    if (S - sh.before < cur.pos + 0.6 * cur.rate) S = cur.nextPhrase(cur.pos + sh.before + 0.8 * cur.rate, 0.125);
    return S;
  }
  // Seconds of real time until Auto DJ hands the move to the engine (a little ahead of the
  // lead-in, which covers the drum fill or riser).
  function untilMix(cur, next) {
    const S = mixMoment(cur, next);
    if (S == null) return null;
    const sh = automix.shape(styleFor(cur, next), cur);
    const lead = Math.max(sh.before, M()?.drums || M()?.fx ? (cur.grid ? cur.grid.bar : 2) : 0);
    return (S - lead - cur.pos) / cur.rate - 2;
  }
  // Where a "run it back" happens: halfway through the song's bars, on a bar.
  function rewindMoment(cur) {
    const g = cur.grid;
    if (!g) return null;
    const n = playBars(opts.mode, g.bar / cur.rate);
    if (n < 8) return null;
    return entryBar(cur) + (n / 2) * g.bar;
  }

  // ---------- the loop ----------
  async function tick() {
    if (!running || mixing || automix.running) return;
    const m = M();
    const cur = current();
    if (!cur) {
      // nothing is playing: either we have not started yet, or someone stopped the music
      if (played.length) { stop('Auto DJ stopped because the music was paused.'); return; }
      const first = queue.shift();
      if (!first) { stop('There are no songs to play.'); return; }
      mixing = true;
      const ok = await automix.start('pop', first, { entry: entryFor(m), quiet: !!m });
      mixing = false;
      if (!ok) { queue.unshift(first); stop(); return; }
      played.push(first); startedAt = null; planMoves();
      paint();
      return;
    }
    if (!startedAt || startedAt.id !== cur.track.id) startedAt = { id: cur.track.id, pos: cur.pos };

    if (!queue.length) {
      if (opts.repeat && played.length > 1) {
        // go round again, carrying on from the song that is playing (not back to the opener)
        const again = planSet(played, { order: opts.order === 'listed' ? 'listed' : 'smart', startId: cur.track.id, energy: m?.energy });
        queue = again.queue.filter((t) => t.id !== cur.track.id); played = [cur.track];
        planMoves();
      } else if (cur.duration - cur.pos < 1.5) { stop('That was the last song.'); return; }
      paint();
      if (!queue.length) return;
    }

    // short-play modes: never wait on a song that has not been analysed yet
    if (m && m.handover === 'bars' && queue[0].analyzed === 0) {
      const j = queue.findIndex((t) => t.analyzed === 1);
      if (j > 0) { queue.unshift(...queue.splice(j, 1)); planMoves(); }
    }
    // ask for the next few songs' analysis early
    for (const t of queue.slice(0, 3)) {
      if (t.analyzed === 0 && !warmed.has(t.id)) { warmed.add(t.id); api.analysis(t.id).catch(() => {}); }
    }

    const next = queue[0];
    const idle = cur.other;
    // have the next song loaded well before it is needed
    if (!idle.playing && idle.loading == null && (!idle.track || idle.track.id !== next.id)) idle.load(next);

    // run it back: rewind this song once, halfway through, then let it play again
    if (m && rewinds.has(cur.track.id) && !startedAt.rewound) {
      const R = rewindMoment(cur);
      if (R != null && (R - cur.pos) / cur.rate < 2.5 && R > cur.pos) {
        startedAt.rewound = true;
        const to = entryBar(cur), n = playBars(opts.mode, cur.grid.bar / cur.rate);
        mixing = true; paint();
        await automix.rewind(cur, { at: R, to, drums: m.drums, fx: opts.fx ? m.fx : false });
        mixing = false;
        // the song now plays from its entry again, for half its bars
        startedAt = { id: cur.track.id, pos: to, bars: n / 2, rewound: true };
        paint();
        return;
      }
    }

    const wait = untilMix(cur, next);
    const playedFor = (cur.pos - startedAt.pos) / cur.rate;
    const minPlay = m ? Math.min(8, m.seconds[0] / 2) : 15;
    if (skipNow || (wait != null && wait <= 0 && playedFor > minPlay)) {
      const now = skipNow;
      skipNow = false;
      mixing = true; paint();
      const style = styleFor(cur, next);
      const at = now ? undefined : mixMoment(cur, next);
      const ok = await automix.start(style, next, {
        at, entry: entryFor(m), quiet: !!m,
        drums: !!m?.drums, fx: opts.fx && m?.fx ? m.fx : false,
      });
      mixing = false;
      if (!running) return;
      if (ok) {
        queue.shift(); played.push(next); history.push(style); startedAt = null;
        planned.delete(next.id);
      } else if (!current()) { stop('Auto DJ stopped.'); return; }
      else { stop('Auto DJ stopped because the mix was interrupted. The music keeps playing.'); return; }
    }
    paint();
  }

  function start() {
    if (running) return;
    const cur = current();
    const list = library.visibleTracks();
    if (list.length < 2 && queue.length < 1) { toast('Auto DJ needs a list with at least two songs. Show a crate or clear the search first.', 'error'); return; }
    if (decks.filter((d) => d.playing).length === 2) { toast('Both decks are playing. Pause one, then start Auto DJ.', 'error'); return; }
    if (!queue.length) build(list, cur);
    running = true; played = cur ? [cur.track] : []; history = []; startedAt = null; skipNow = false;
    planMoves();
    timer = setInterval(tick, 100);
    tick(); paint();
    toast(`Auto DJ is on (${M() ? M().name : 'Custom'}): ${queue.length + played.length} songs from ${source}.`);
  }

  function build(list, cur) {
    source = library.viewName();
    const selected = library.selectedTrack();
    const startId = cur ? cur.track.id : selected && list.some((t) => t.id === selected.id) ? selected.id : null;
    const withCur = cur && !list.some((t) => t.id === cur.track.id) ? [cur.track, ...list] : list;
    const order = M() ? M().order : opts.order;
    const plan = planSet(withCur, { order, startId, energy: M()?.energy });
    skipped = plan.skipped;
    queue = cur ? plan.queue.filter((t) => t.id !== cur.track.id) : plan.queue;
    planMoves();
  }

  function stop(message) {
    if (!running) return;
    running = false; clearInterval(timer);
    if (mixing) automix.cancel();
    if (message) toast(message);
    paint();
  }

  function replan() {
    // re-order what is left, starting from whatever is playing
    const cur = current();
    if (!queue.length) { paint(); return; }
    const anchor = cur ? cur.track : null;
    const order = M() ? M().order : opts.order;
    const plan = planSet(anchor ? [anchor, ...queue] : queue, { order, startId: anchor?.id ?? null, energy: M()?.energy });
    queue = plan.queue.filter((t) => !anchor || t.id !== anchor.id);
    planMoves();
    paint();
  }

  // ---------- UI ----------
  const startBtn = h('button.btn.btn-ai.adj-start', { type: 'button', onclick: () => (running ? stop('Auto DJ is off. The music keeps playing.') : start()) });
  const skipBtn = h('button.btn', { type: 'button', text: 'Mix to next song now', title: 'Start the change to the next song straight away', onclick: () => { if (running && !mixing && queue.length) { skipNow = true; tick(); } } });
  const modeBtns = [...MODE_IDS, 'custom'].map((id) => h('button.btn.adj-mode', {
    type: 'button', text: MODES[id]?.name || 'Custom',
    onclick: () => {
      opts.mode = id; save();
      if (!running) queue = [];
      replan(); paint();
    },
  }));
  const blurb = h('.adj-blurb');
  const orderSel = h('select.select', { 'aria-label': 'Running order', onchange: () => { opts.order = orderSel.value; save(); replan(); } },
    ...ORDERS.map(([v, t]) => h('option', { value: v, text: t, selected: v === opts.order })));
  const lenSel = h('select.select', { 'aria-label': 'How long to play each song', onchange: () => { opts.maxPlay = Number(lenSel.value); save(); paint(); } },
    ...LENGTHS.map(([v, t]) => h('option', { value: v, text: t, selected: v === opts.maxPlay })));
  const custom = h('.adj-custom', {}, orderSel, lenSel);
  const fxBox = h('input', { type: 'checkbox', checked: opts.fx, onchange: () => { opts.fx = fxBox.checked; save(); paint(); } });
  const fxLabel = h('label.adj-check', { title: 'Air horn, siren, risers and impacts on drops (Nightclub and Peak-time)' }, fxBox, h('span', { text: 'Sound effects' }));
  const repeatBox = h('input', { type: 'checkbox', checked: opts.repeat, onchange: () => { opts.repeat = repeatBox.checked; save(); } });
  const rebuildBtn = h('button.btn.btn-small', {
    type: 'button', text: 'Use the library list', title: 'Replace the queue with the songs the Library tab is showing',
    onclick: () => { build(library.visibleTracks(), current()); paint(); toast(`Queue rebuilt from ${source}: ${queue.length} songs.`); },
  });
  const addBtn = h('button.btn.btn-small', {
    type: 'button', text: 'Play selected song next', title: 'Put the song selected in the Library at the front of the queue',
    onclick: () => {
      const t = library.selectedTrack();
      if (!t) return toast('Select a song in the Library tab first.');
      queue = [t, ...queue.filter((q) => q.id !== t.id)];
      planMoves(); paint(); toast(`${t.title} will play next.`);
    },
  });
  const now = h('.adj-now');
  const tbody = h('tbody');
  const table = h('table.tracks.adj-table', {}, h('thead', {}, h('tr', {},
    h('th.adj-n', { text: '' }), h('th', { text: 'Coming up' }), h('th.col-artist', { text: 'Artist' }),
    h('th.col-bpm', { text: 'BPM' }), h('th.col-camelot', { text: 'Key' }), h('th.adj-how', { text: 'Comes in with' }), h('th.adj-act', { text: '' }))), tbody);
  const empty = h('.lib-empty');
  const foot = h('.adj-foot');

  const el = h('.autodj', {},
    h('.adj-bar', {}, startBtn, skipBtn, h('.adj-modes', { role: 'group', 'aria-label': 'Auto DJ mode' }, ...modeBtns), h('.spacer'),
      fxLabel, h('label.adj-check', {}, repeatBox, h('span', { text: 'Start over at the end' }))),
    h('.adj-sub', {}, blurb, custom),
    now,
    h('.lib-scroll.adj-scroll', {}, table, empty),
    h('.adj-footrow', {}, foot, h('.spacer'), addBtn, rebuildBtn));

  const move = (i, d) => { const j = i + d; if (j < 0 || j >= queue.length) return; [queue[i], queue[j]] = [queue[j], queue[i]]; planMoves(); paint(); };

  let paintedKey = '';
  function paint() {
    const m = M();
    startBtn.textContent = running ? 'Stop Auto DJ' : 'Start Auto DJ';
    startBtn.classList.toggle('on', running);
    skipBtn.disabled = !running || mixing || !queue.length;
    modeBtns.forEach((b, i) => b.classList.toggle('on', [...MODE_IDS, 'custom'][i] === opts.mode));
    blurb.textContent = m ? m.blurb : 'Choose the order and how long each song plays.';
    custom.hidden = !!m;
    fxLabel.hidden = !(m?.fx);
    const cur = current();
    const next = queue[0];

    // status line
    let line;
    if (!running) line = queue.length ? `Ready: ${queue.length} songs queued from ${source}.` : 'Auto DJ plays a whole list for you and mixes every song into the next.';
    else if (mixing) line = next ? `${STYLE_LABEL[planned.get(next.id)] || 'Mixing'} into ${next.title}…` : 'Working the decks…';
    else if (cur && next) {
      const w = untilMix(cur, next);
      const how = (STYLE_LABEL[styleFor(cur, next)] || 'mix').toLowerCase();
      line = `Now playing ${cur.track.title}. Next: ${next.title}, ${w != null && w > 0 ? `${how} in ${fmtTime(w + 2)}` : `${how} coming up`}.`;
    } else if (cur) line = `Now playing ${cur.track.title}. Nothing queued after it.`;
    else line = 'Starting…';
    now.textContent = line;

    // queue table (rebuilt only when its contents change)
    const key = `${running}|${opts.mode}|${cur?.track.id}|${history.length}|${queue.map((t) => `${t.id}:${planned.get(t.id)}`).join(',')}`;
    if (key !== paintedKey) {
      paintedKey = key;
      let prev = cur ? { bpm: cur.effectiveBpm } : null;
      fill(tbody, ...queue.slice(0, 200).map((t, i) => {
        const style = prev ? planned.get(t.id) : null;
        const smooth = prev && blendable(prev.bpm, t.bpm);
        const label = style ? `${STYLE_LABEL[style] || style}${rewinds.has(t.id) ? ' + run it back' : ''}` : null;
        const row = h('tr', {},
          h('td.adj-n', { text: String(i + 1) }),
          h('td', { text: t.title || t.file }),
          h('td.col-artist', { text: t.artist || '' }),
          h('td.col-bpm', { text: t.bpm ? t.bpm.toFixed(0) : '–' }),
          h('td.col-camelot', { text: t.camelot || '–' }),
          h('td.adj-how', {}, label ? h('span.tag', { class: smooth ? 'ready' : '', text: label }) : h('span.dim', { text: running ? 'Next up' : 'Starts the set' })),
          h('td.adj-act', {},
            h('button.side-x', { type: 'button', text: '↑', title: 'Play earlier', onclick: () => move(i, -1) }),
            h('button.side-x', { type: 'button', text: '↓', title: 'Play later', onclick: () => move(i, 1) }),
            h('button.side-x', { type: 'button', text: '×', title: 'Take out of the queue', onclick: () => { queue.splice(i, 1); planMoves(); paint(); } })));
        prev = t;
        return row;
      }));
      table.hidden = !queue.length;
      empty.hidden = !!queue.length;
      if (!queue.length) {
        fill(empty,
          h('p.empty-title', { text: 'Let Auto DJ run the set' }),
          h('p', { text: 'Pick a mode above. Then, in the Library tab, show the songs you want (everything, a crate, or a search) and press Auto DJ this list, or press Start Auto DJ here.' }),
          h('p', { text: 'You can still jump in: reorder the queue, skip ahead, or press Stop and take over the decks.' }));
      }
      const per = (t) => (m ? Math.min(m.target, t.duration || m.target) : opts.maxPlay ? Math.min(opts.maxPlay, t.duration) : t.duration);
      const mins = queue.reduce((s, t) => s + per(t), 0) / 60;
      foot.textContent = queue.length
        ? `${queue.length} songs queued, about ${mins >= 90 ? `${(mins / 60).toFixed(1)} hours` : mins < 1.5 ? `${Math.round(mins * 60)} seconds` : `${Math.round(mins)} minutes`}.${skipped ? ` ${skipped} alternate version${skipped === 1 ? '' : 's'} of the same song left out.` : ''}`
        : '';
    }
    for (const fn of listeners) fn({ running, mixing, line });
  }
  setInterval(() => { if (running && !mixing) paint(); }, 1000);
  paint();

  return {
    el, start, stop,
    get running() { return running; },
    get queue() { return queue; },
    get history() { return history; },
    options: opts,
    onChange(fn) { listeners.add(fn); },
    // "Auto DJ this list" from the library: build from what is showing, open the tab, start
    startFromLibrary() {
      if (running) { showTab('autodj'); return; }
      queue = [];
      showTab('autodj');
      start();
    },
  };
}
