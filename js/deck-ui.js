// The control panel for one deck.
import { h, knob, fmtTime, toast } from './controls.js';
import { STEMS, STEM_LABELS } from './deck.js';
import { Overview, CUE_COLORS } from './waveform.js';
import { store } from './store.js';
import { api } from './api.js';

const LOOP_SIZES = [1, 2, 4, 8, 16];
const RANGES = [0.08, 0.16, 0.5];

export function loadTrack(deck, track) {
  if (!track) return;
  if (deck.playing) return toast(`Deck ${deck.name} is playing. Pause it before loading another track.`, 'error');
  deck.load(track);
}

export function buildDeck(deck, colors) {
  const btn = (label, props = {}) => h('button.btn', { type: 'button', text: label, ...props });

  // ----- header -----
  const title = h('.deck-title', { text: `Deck ${deck.name} is empty` });
  const artist = h('.deck-artist', { text: 'Drag a track here, or select one and press Shift + ' + (deck.index ? '→' : '←') });
  // The deck's music-video screen. Silent: the sound comes from the deck itself.
  const video = h('video.deck-video', { muted: true, playsInline: true, preload: 'auto' });
  const screenNote = h('.screen-note');
  const screen = h('.deck-screen', { title: 'Music video for this deck. Double-click for full screen.' },
    video, h('img.screen-logo', { src: 'logo.svg', alt: '' }), screenNote);
  screen.addEventListener('dblclick', () => {
    if (video.classList.contains('has-video')) video.requestFullscreen?.().catch(() => {});
  });
  const bpm = h('.readout-big', { text: '--' });
  const tempoPct = h('.readout-sub', { text: '0.0%' });
  const key = h('.readout-big.key', { text: '--' });
  const keyName = h('.readout-sub', { text: 'key' });
  const elapsed = h('.readout-big', { text: '0:00' });
  const remain = h('.readout-sub', { text: '-0:00' });
  const overviewCanvas = h('canvas.overview', { title: 'Click to jump' });
  const overview = new Overview(overviewCanvas, deck, colors);
  const progress = h('.load-progress', {}, h('i'));

  // ----- transport -----
  const cueBtn = btn('Cue', { class: 'btn-cue', title: 'Cue: set the cue point when stopped, return to it when playing' });
  cueBtn.addEventListener('pointerdown', (e) => { cueBtn.setPointerCapture(e.pointerId); deck.cueDown(); });
  cueBtn.addEventListener('pointerup', () => deck.cueUp());
  cueBtn.addEventListener('pointercancel', () => deck.cueUp());
  const playBtn = btn('Play', { class: 'btn-play', onclick: () => deck.toggle() });
  const syncBtn = btn('Sync', {
    title: 'Match the other deck\'s tempo and line up the beats',
    onclick: () => { if (!deck.sync()) toast('Sync needs a track with a detected tempo on both decks.'); },
  });
  const bendBtn = (label, amount, tip) => {
    const b = btn(label, { class: 'btn-small', title: tip });
    b.addEventListener('pointerdown', (e) => { b.setPointerCapture(e.pointerId); deck.setBend(amount); });
    b.addEventListener('pointerup', () => deck.setBend(0));
    b.addEventListener('pointercancel', () => deck.setBend(0));
    return b;
  };

  // ----- hot cues -----
  const hotBtns = CUE_COLORS.map((color, i) => {
    const b = btn(String(i + 1), { class: 'btn-hot', title: `Hot cue ${i + 1}: click to set or jump, Shift-click to clear` });
    b.style.setProperty('--cue', color);
    b.addEventListener('click', (e) => (e.shiftKey ? deck.clearHotcue(i) : deck.hotcue(i)));
    return b;
  });

  // ----- loops -----
  const loopBtns = LOOP_SIZES.map((n) => btn(String(n), { class: 'btn-loop', title: `Loop ${n} beat${n > 1 ? 's' : ''}`, onclick: () => deck.autoLoop(n) }));
  const loopIn = btn('In', { class: 'btn-small', title: 'Mark loop start', onclick: () => deck.loopIn() });
  const loopOut = btn('Out', { class: 'btn-small', title: 'Mark loop end and start looping', onclick: () => deck.loopOut() });
  const loopHalf = btn('½', { class: 'btn-small', title: 'Halve the loop', onclick: () => deck.scaleLoop(0.5) });
  const loopDouble = btn('×2', { class: 'btn-small', title: 'Double the loop', onclick: () => deck.scaleLoop(2) });
  const loopExit = btn('Exit', { class: 'btn-small', title: 'Leave the loop', onclick: () => deck.exitLoop() });

  // ----- stems -----
  const stemBtns = STEMS.map((name) => {
    const b = btn(STEM_LABELS[name], { class: 'btn-stem', title: `Mute or unmute ${STEM_LABELS[name].toLowerCase()}. Alt-click to solo.` });
    b.addEventListener('click', (e) => {
      if (e.altKey) {
        const soloed = STEMS.every((n) => (n === name ? !deck.stemMutes[n] : deck.stemMutes[n]));
        deck.soloStem(soloed ? null : name);
      } else deck.setStemMute(name, !deck.stemMutes[name]);
    });
    return b;
  });
  const stemNote = h('.stem-note');
  const stemAction = btn('Prepare stems', {
    class: 'btn-small', onclick: () => deck.track && api.prepareStems(deck.track.id).catch((e) => toast(e.message, 'error')),
  });
  const stemRow = h('.row.stems', { hidden: !api.capabilities.stems }, h('.row-label', { text: 'Stems' }), ...stemBtns, stemNote, stemAction);

  // ----- tempo and key -----
  const tempo = h('input.tempo-fader', { type: 'range', min: -1, max: 1, step: 0.0005, value: 0, 'aria-label': `Deck ${deck.name} tempo`, title: 'Tempo: down is faster. Double-click to reset.' });
  tempo.addEventListener('input', () => deck.setTempo(1 + Number(tempo.value) * deck.tempoRange));
  tempo.addEventListener('dblclick', () => deck.setTempo(1));
  const rangeBtn = btn('±8%', {
    class: 'btn-small', title: 'Tempo fader range',
    onclick: () => deck.setTempoRange(RANGES[(RANGES.indexOf(deck.tempoRange) + 1) % RANGES.length]),
  });
  const lockBtn = btn('Key lock', { class: 'btn-small', title: 'Keep the musical key when the tempo changes', onclick: () => deck.setKeylock(!deck.keylock) });
  const keyDown = btn('−', { class: 'btn-small', title: 'Shift key down a semitone', onclick: () => deck.setSemis(deck.semis - 1) });
  const keyUp = btn('+', { class: 'btn-small', title: 'Shift key up a semitone', onclick: () => deck.setSemis(deck.semis + 1) });
  const keyReset = btn('0', { class: 'btn-small', title: 'Original key', onclick: () => deck.setSemis(0) });

  // ----- effects -----
  const fxSelect = h('select.select', { 'aria-label': 'Effect', onchange: () => deck.channel.setFx({ fx: fxSelect.value }, deck.effectiveBpm) },
    h('option', { value: 'echo', text: 'Echo' }), h('option', { value: 'reverb', text: 'Reverb' }));
  const fxBeats = h('select.select', { 'aria-label': 'Echo time', title: 'Echo time in beats', onchange: () => deck.channel.setFx({ beats: Number(fxBeats.value) }, deck.effectiveBpm) },
    ...[['¼ beat', 0.25], ['½ beat', 0.5], ['¾ beat', 0.75], ['1 beat', 1], ['2 beats', 2]].map(([t, v]) => h('option', { value: v, text: t, selected: v === 0.5 })));
  const fxAmount = knob({ label: 'Amount', min: 0, max: 1, value: 0.5, size: 'small', onChange: (v) => deck.channel.setFx({ amount: v }, deck.effectiveBpm) });
  const fxOn = btn('FX on', { class: 'btn-small btn-fx', onclick: () => { deck.channel.setFx({ on: !deck.channel.state.fxOn }, deck.effectiveBpm); paint(); } });

  const el = h(`section.deck.deck-${deck.name.toLowerCase()}`, { 'aria-label': `Deck ${deck.name}` },
    h('.deck-head', {},
      h('.deck-letter', { text: deck.name }),
      h('.deck-names', {}, title, artist),
      screen),
    h('.deck-body', {},
      h('.deck-main', {},
        h('.readouts', {},
          h('.readout', {}, bpm, tempoPct),
          h('.readout', {}, key, keyName),
          h('.readout.time', {}, elapsed, remain)),
        h('.overview-wrap', {}, overviewCanvas, progress),
        h('.row.transport', {}, cueBtn, playBtn, syncBtn,
          h('.spacer'), bendBtn('◀ Nudge', -0.04, 'Nudge: hold to slow down briefly'), bendBtn('Nudge ▶', 0.04, 'Nudge: hold to speed up briefly')),
        h('.row', {}, h('.row-label', { text: 'Hot cues' }), ...hotBtns),
        h('.row', {}, h('.row-label', { text: 'Loop' }), loopIn, loopOut, loopHalf, ...loopBtns, loopDouble, loopExit),
        stemRow,
        h('.row.fx', {}, h('.row-label', { text: 'Effect' }), fxSelect, fxBeats, fxAmount, fxOn)),
      h('.deck-tempo', {},
        h('.tempo-track', {}, tempo),
        rangeBtn, lockBtn,
        h('.key-shift', {}, keyDown, keyReset, keyUp))));

  // ----- drag a library row onto the deck -----
  const onDrop = (e) => {
    const id = Number(e.dataTransfer.getData('text/baezbeats-track'));
    if (!id) return;
    e.preventDefault(); el.classList.remove('drop');
    loadTrack(deck, store.tracks.get(id));
  };
  el.addEventListener('dragover', (e) => { if (e.dataTransfer.types.includes('text/baezbeats-track')) { e.preventDefault(); el.classList.add('drop'); } });
  el.addEventListener('dragleave', () => el.classList.remove('drop'));
  el.addEventListener('drop', onDrop);

  // ----- painting -----
  function paintStems() {
    const t = deck.track;
    const job = t && store.stems.jobs[t.id];
    const ready = deck.stemsLoaded;
    stemBtns.forEach((b, i) => {
      b.disabled = !ready;
      b.classList.toggle('on', ready && !deck.stemMutes[STEMS[i]]);
    });
    let note = '', action = false;
    if (!t) note = '';
    else if (ready) note = '';
    else if (deck.stemsLoading) note = 'Loading stems…';
    else if (job) note = job.state === 'queued' ? 'Waiting to separate…' : `Separating ${Math.round((job.progress || 0) * 100)}%`;
    else if (!store.stems.installed) note = 'Not installed (see Settings)';
    else action = true;
    stemNote.textContent = note;
    stemAction.hidden = !action;
  }

  function paint() {
    const t = deck.track;
    el.classList.toggle('loaded', !!t);
    el.classList.toggle('playing', deck.playing);
    if (t) {
      title.textContent = t.title || t.file;
      artist.textContent = t.artist || (deck.loading != null ? 'Loading…' : t.file);
    } else {
      title.textContent = `Deck ${deck.name} is empty`;
      artist.textContent = `Drag a track here, or select one and press Shift + ${deck.index ? '→' : '←'}`;
    }
    screenNote.textContent = !t ? `Deck ${deck.name}` : video.classList.contains('broken') ? "This video can't play" : t.has_video ? '' : 'Audio only';
    playBtn.textContent = deck.playing ? 'Pause' : 'Play';
    playBtn.classList.toggle('on', deck.playing);
    playBtn.disabled = cueBtn.disabled = !deck.ready;
    bpm.textContent = deck.bpm ? deck.effectiveBpm.toFixed(1) : '--';
    const pct = (deck.tempo - 1) * 100;
    tempoPct.textContent = `${pct >= 0 ? '+' : ''}${pct.toFixed(1)}%`;
    key.textContent = deck.keyLabel || '--';
    keyName.textContent = deck.key ? `key ${deck.key}` : 'key';
    tempo.value = (deck.tempo - 1) / deck.tempoRange;
    rangeBtn.textContent = `±${Math.round(deck.tempoRange * 100)}%`;
    lockBtn.classList.toggle('on', deck.keylock);
    keyReset.textContent = deck.semis ? (deck.semis > 0 ? `+${deck.semis}` : String(deck.semis)) : '0';
    keyReset.classList.toggle('on', deck.semis !== 0);
    hotBtns.forEach((b, i) => b.classList.toggle('set', deck.hotcues[i] != null));
    loopBtns.forEach((b, i) => b.classList.toggle('on', deck.loop?.beats === LOOP_SIZES[i]));
    loopExit.classList.toggle('on', !!deck.loop);
    loopIn.classList.toggle('on', deck.loopInPoint != null && !deck.loop);
    fxOn.classList.toggle('on', deck.channel.state.fxOn);
    fxBeats.disabled = fxSelect.value !== 'echo';
    progress.hidden = deck.loading == null;
    progress.firstChild.style.width = `${(deck.loading || 0) * 100}%`;
    paintStems();
  }

  for (const ev of ['load', 'state', 'analysis', 'ready', 'tempo', 'cues', 'loop', 'stems', 'progress']) deck.addEventListener(ev, paint);
  deck.addEventListener('error', (e) => toast(e.detail, 'error'));
  video.addEventListener('error', () => setTimeout(paint, 0));
  fxSelect.addEventListener('change', paint);
  store.addEventListener('stems', paintStems);
  store.addEventListener('track', (e) => {
    const t = e.detail;
    if (deck.track && t && t.id === deck.track.id) {
      deck.track = t;
      if (t.stems === 1 && deck.ready) deck.loadStems();
      paintStems();
    }
  });
  paint();

  return {
    el, video,
    // called every animation frame
    tick() {
      const pos = deck.pos;
      elapsed.textContent = fmtTime(pos);
      remain.textContent = fmtTime(-(deck.duration - pos) / (deck.tempo || 1));
      el.classList.toggle('ending', deck.playing && deck.duration - pos < 20);
      overview.draw();
    },
  };
}
