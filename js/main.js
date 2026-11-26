// BaezBeats: wires the decks, mixer, library, sequencer and video together.
import { h, fmtTime, toast } from './controls.js';
import { engine } from './engine.js';
import { Deck } from './deck.js';
import { buildDeck, loadTrack } from './deck-ui.js';
import { buildMixer } from './mixer-ui.js';
import { buildLibrary } from './library-ui.js';
import { buildSequencer } from './sequencer.js';
import { buildVideo } from './video.js';
import { buildAutomix } from './automix.js';
import { buildAutoDJ } from './autodj.js';
import { buildMashups } from './mashups.js';
import { ZoomWave } from './waveform.js';
import { addMusic, openSettings } from './dialogs.js';
import { initGetMusic, openGetMusic } from './getmusic.js';
import { store, refresh, startLive } from './store.js';
import { api, MODE } from './api.js';

const COLORS = [
  { low: '#b3541e', mid: '#ffa726', high: '#ffe3ae', loop: 'rgba(255,167,38,0.22)' },
  { low: '#14708a', mid: '#35c9d6', high: '#c9f6f7', loop: 'rgba(53,201,214,0.22)' },
];

// Settings saved before the app was renamed (Wavedeck -> BaezBeats) carry over.
for (const k of ['cue', 'patterns', 'autodj']) {
  const old = localStorage.getItem(`wavedeck.${k}`);
  if (old != null && localStorage.getItem(`baezbeats.${k}`) == null) localStorage.setItem(`baezbeats.${k}`, old);
}

const decks = [new Deck(0), new Deck(1)];
decks[0].other = decks[1]; decks[1].other = decks[0];
const deckUIs = decks.map((d, i) => buildDeck(d, COLORS[i]));
const mixer = buildMixer(decks);
const library = buildLibrary(decks, addMusic);
initGetMusic(decks);
const sequencer = buildSequencer(decks);
const video = buildVideo(decks, deckUIs.map((u) => u.video));
const automix = buildAutomix(decks, mixer, library);
automix.useDrums(sequencer);
const autodj = buildAutoDJ(decks, automix, library, (id) => showTab(id));
const autoListBtn = h('button.btn.btn-autolist', {
  type: 'button', text: 'Auto DJ this list', title: 'Let Auto DJ play and mix every song in this list',
  onclick: () => autodj.startFromLibrary(),
});
library.bar.prepend(automix.el, autoListBtn);
const mashups = buildMashups(decks, automix, library);

// ----- scrolling waveforms -----
const waves = decks.map((deck, i) => {
  const canvas = h('canvas.zoom', { 'aria-label': `Deck ${deck.name} waveform. Drag to scrub.` });
  const hint = h('.wave-hint', { text: `Deck ${deck.name}` });
  const row = h(`.wave.wave-${deck.name.toLowerCase()}`, {}, h('.wave-letter', { text: deck.name }), canvas, hint);
  row.addEventListener('dragover', (e) => { if (e.dataTransfer.types.includes('text/baezbeats-track')) { e.preventDefault(); row.classList.add('drop'); } });
  row.addEventListener('dragleave', () => row.classList.remove('drop'));
  row.addEventListener('drop', (e) => {
    e.preventDefault(); row.classList.remove('drop');
    loadTrack(deck, store.tracks.get(Number(e.dataTransfer.getData('text/baezbeats-track'))));
  });
  const paintHint = () => {
    hint.textContent = !deck.track ? `Deck ${deck.name}: drag a track here`
      : deck.loading != null ? `Loading ${Math.round(deck.loading * 100)}%`
        : !deck.peaks ? 'Working out tempo and key…' : '';
  };
  for (const ev of ['load', 'progress', 'ready', 'analysis']) deck.addEventListener(ev, paintHint);
  paintHint();
  return { row, view: new ZoomWave(canvas, deck, COLORS[i]) };
});

// ----- top bar -----
const clock = h('.clock');
const recBtn = h('button.btn.btn-rec', { type: 'button', text: 'Record mix', title: 'Record everything going to the speakers' });
recBtn.addEventListener('click', async () => {
  if (!engine.recorder) {
    engine.startRecording();
    recBtn.classList.add('on');
  } else {
    const blob = await engine.stopRecording();
    recBtn.classList.remove('on'); recBtn.textContent = 'Record mix';
    if (!blob?.size) return;
    const stamp = new Date().toLocaleString('sv').replace(/:/g, '.').slice(0, 16);
    const a = h('a', { href: URL.createObjectURL(blob), download: `BaezBeats mix ${stamp}.${blob.type.includes('mp4') ? 'm4a' : 'webm'}` });
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 10000);
    toast('Mix saved to your Downloads folder');
  }
});
const outBtn = h('button.btn', {
  type: 'button', text: 'Open video output', title: 'Open the music-video window. Drag it to the projector or second screen.',
  onclick: () => { if (video.toggleOutput() === false) toast('Chrome blocked the video window. Allow pop-ups for this page and try again.', 'error'); },
});
video.onChange((open) => { outBtn.textContent = open ? 'Close video output' : 'Open video output'; outBtn.classList.toggle('on', open); });
const settingsBtn = h('button.btn', { type: 'button', text: 'Settings', onclick: openSettings });
// Show or hide the two music-video screens (kept between visits).
const screensBtn = h('button.btn', { type: 'button', text: 'Screens', title: 'Show or hide the music-video screens on the decks' });
const setScreens = (on) => {
  document.body.classList.toggle('no-screens', !on);
  screensBtn.classList.toggle('on', on);
  localStorage.setItem('baezbeats.screens', on ? '1' : '0');
};
screensBtn.addEventListener('click', () => setScreens(document.body.classList.contains('no-screens')));
setScreens(localStorage.getItem('baezbeats.screens') !== '0');

// ----- browser version: reconnecting music, dropping folders, working offline -----
// Chrome asks once per visit (unless "Allow on every visit" was chosen) before the page
// may read a folder again; that needs a click, so it gets a bar of its own.
const reconnectBar = h('.reconnect', { hidden: true, role: 'status' },
  h('span', { text: 'Chrome needs your OK to read your music again.' }),
  h('button.btn.btn-primary', {
    type: 'button', text: 'Reconnect music',
    onclick: async () => {
      try { await api.reconnect(); await refresh(); } catch (e) { toast(e.message, 'error'); }
    },
  }));
store.addEventListener('permission', () => { reconnectBar.hidden = !store.needsPermission; });

if (MODE === 'browser') {
  document.body.classList.add('web-version');
  // Drop folders or files from Finder onto the library to add them.
  const zone = library.el;
  zone.addEventListener('dragover', (e) => {
    if (!e.dataTransfer.types.includes('Files')) return;
    e.preventDefault(); zone.classList.add('drop-music');
  });
  zone.addEventListener('dragleave', (e) => { if (!zone.contains(e.relatedTarget)) zone.classList.remove('drop-music'); });
  zone.addEventListener('drop', async (e) => {
    if (!e.dataTransfer.types.includes('Files')) return;
    e.preventDefault(); zone.classList.remove('drop-music');
    const items = [...e.dataTransfer.items].filter((i) => i.kind === 'file');
    const handles = (await Promise.all(items.map((i) => i.getAsFileSystemHandle?.()))).filter(Boolean);
    if (!handles.length) return toast('Drop a folder or music files from Finder.', 'error');
    toast('Added. Reading your music…');
    try { await api.addHandles(handles); await refresh(); } catch (err) { toast(err.message, 'error'); }
  });
  // Keep working without internet once the page has been opened (parties, bad Wi-Fi).
  if ('serviceWorker' in navigator && document.querySelector('meta[name="baezbeats-mode"]')) {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }
}

// ----- library / drums tabs -----
const tabs = [['library', 'Library', library.el], ['autodj', 'Auto DJ', autodj.el], ['mashups', 'Mashups', mashups.el], ['drums', 'Drum sequencer', sequencer.el]]
  .filter(([id]) => id !== 'mashups' || api.capabilities.stems);
const tabBtns = tabs.map(([id, label]) => h('button.tab', { type: 'button', role: 'tab', text: label, onclick: () => showTab(id) }));
function showTab(id) {
  if (id === 'mashups') setTimeout(() => mashups.paint(), 0);
  tabs.forEach(([tid, , el], i) => { el.hidden = tid !== id; tabBtns[i].classList.toggle('on', tid === id); tabBtns[i].setAttribute('aria-selected', String(tid === id)); });
}

// Status pill in the top bar while Auto DJ is running (click to open its tab).
const autoPill = h('button.auto-pill', { type: 'button', hidden: true, title: 'Open Auto DJ', onclick: () => showTab('autodj') });
autodj.onChange(({ running, line }) => { autoPill.hidden = !running; autoPill.textContent = running ? `Auto DJ: ${line}` : ''; });

document.getElementById('app').append(
  reconnectBar,
  h('header.top', {},
    h('.brand', {}, h('img.brand-mark', { src: 'logo.svg', alt: '' }), h('span.brand-name', { text: 'BaezBeats' })),
    autoPill,
    h('button.btn.btn-primary.get-music', { type: 'button', text: 'Get music', title: 'Add songs from this computer or SoundCloud', onclick: () => openGetMusic() }),
    h('.top-actions', {}, clock, recBtn, screensBtn, outBtn, settingsBtn)),
  h('section.waves', { 'aria-label': 'Waveforms' }, waves[0].row, waves[1].row),
  h('main.console', {}, deckUIs[0].el, mixer.el, deckUIs[1].el),
  h('section.bottom', {}, h('.tabs', { role: 'tablist' }, ...tabBtns), ...tabs.map(([, , el]) => el)));
showTab('library');

deckUIs.forEach((u, i) => u.video.addEventListener('error', () => {
  if (!u.video.dataset.src) return;
  u.video.classList.add('broken');
  toast(`Deck ${decks[i].name}: Chrome cannot play this file's video, so it will play as audio only.`, 'error');
}));

// ----- animation loop -----
function frame() {
  for (const w of waves) w.view.draw();
  for (const u of deckUIs) u.tick();
  mixer.tick();
  if (engine.recorder) recBtn.textContent = `Stop recording ${fmtTime((Date.now() - engine.recStarted) / 1000)}`;
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
const tickClock = () => { clock.textContent = new Date().toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }); };
tickClock(); setInterval(tickClock, 10000);

// ----- keyboard -----
const KEYS = {
  KeyW: [0, 'toggle'], KeyO: [1, 'toggle'],
  KeyQ: [0, 'cue'], KeyI: [1, 'cue'],
  KeyE: [0, 'sync'], KeyP: [1, 'sync'],
  KeyA: [0, 'bend', -0.04], KeyS: [0, 'bend', 0.04], KeyK: [1, 'bend', -0.04], KeyL: [1, 'bend', 0.04],
  KeyZ: [0, 'loop'], KeyX: [0, 'exit'], KeyN: [1, 'loop'], KeyM: [1, 'exit'],
  Digit1: [0, 'hot', 0], Digit2: [0, 'hot', 1], Digit3: [0, 'hot', 2], Digit4: [0, 'hot', 3],
  Digit7: [1, 'hot', 0], Digit8: [1, 'hot', 1], Digit9: [1, 'hot', 2], Digit0: [1, 'hot', 3],
};
const typing = (e) => e.target.closest?.('input:not([type=range]), textarea, select, dialog');

addEventListener('keydown', (e) => {
  if (typing(e)) { if (e.key === 'Escape') e.target.blur(); return; }
  if (e.metaKey || e.ctrlKey || e.altKey) return;
  if (e.code === 'Slash') { e.preventDefault(); showTab('library'); library.search.focus(); return; }
  if (e.code === 'Space') { e.preventDefault(); if (!e.repeat) (sequencer.running ? sequencer.stop() : sequencer.start()); return; }
  if (e.code === 'ArrowDown' || e.code === 'ArrowUp') {
    if (e.target.closest?.('.knob-dial, input[type=range]')) return;
    e.preventDefault(); library.move(e.code === 'ArrowDown' ? 1 : -1); return;
  }
  if (e.shiftKey && (e.code === 'ArrowLeft' || e.code === 'ArrowRight')) {
    e.preventDefault();
    const t = library.selectedTrack();
    if (t) loadTrack(decks[e.code === 'ArrowLeft' ? 0 : 1], t); else toast('Select a track in the library first.');
    return;
  }
  const k = KEYS[e.code];
  if (!k || e.repeat || e.shiftKey) return;
  const [i, action, arg] = k, deck = decks[i];
  e.preventDefault();
  if (action === 'toggle') deck.toggle();
  else if (action === 'cue') deck.cueDown();
  else if (action === 'sync') { if (!deck.sync()) toast('Sync needs a track with a detected tempo on both decks.'); }
  else if (action === 'bend') deck.setBend(arg);
  else if (action === 'loop') deck.autoLoop(4);
  else if (action === 'exit') deck.exitLoop();
  else if (action === 'hot') deck.hotcue(arg);
});
addEventListener('keyup', (e) => {
  const k = KEYS[e.code];
  if (!k) return;
  if (k[1] === 'cue') decks[k[0]].cueUp();
  if (k[1] === 'bend') decks[k[0]].setBend(0);
});

// Don't lose a set to an accidental reload.
addEventListener('beforeunload', (e) => { if (decks.some((d) => d.playing) || engine.recorder) e.preventDefault(); });

// ----- start -----
refresh().catch((e) => toast(MODE === 'server' ? `Could not reach the BaezBeats server: ${e.message}` : `The library could not be opened: ${e.message}`, 'error'));
startLive();
const savedCue = JSON.parse(localStorage.getItem('baezbeats.cue') || 'null');
if (savedCue && savedCue.mode !== 'off') engine.route(savedCue.mode, savedCue.device).catch(() => {});

// Handy for troubleshooting from the browser console.
window.baezbeats = { decks, engine, mixer, sequencer, library, store, video, automix, autodj, mashups };
