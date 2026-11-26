// Folder picker and settings dialogs.
import { h, fill, toast } from './controls.js';
import { api } from './api.js';
import { store, refresh } from './store.js';
import { engine, ctx } from './engine.js';

export function dialog(title, ...body) {
  const d = h('dialog.dialog', {},
    h('.dialog-head', {}, h('h2', { text: title }), h('button.btn.btn-small', { type: 'button', text: 'Close', onclick: () => d.close() })),
    ...body);
  d.addEventListener('close', () => d.remove());
  document.body.append(d);
  d.showModal();
  return d;
}

// Add music with the Mac's own Finder chooser ("folder" or "files").
let picking = false;
export async function addMusic(kind) {
  if (picking) return toast('The file chooser is already open. Look for it behind this window.');
  picking = true;
  try {
    const r = await api.pick(kind);
    if (r.cancelled) return;
    if (!r.added) return toast('Nothing playable was picked.', 'error');
    toast(api.mode === 'browser' ? 'Added. Reading your music…' : kind === 'folder' ? 'Folder added. Reading your tracks…' : `Adding ${r.added} file${r.added === 1 ? '' : 's'}…`);
    setTimeout(refresh, 400);
  } catch (e) {
    // Mac app without its Finder chooser: fall back to the built-in folder browser.
    if (kind === 'folder' && api.mode === 'server') openFolderDialog();
    else toast(`The file chooser could not open: ${e.message}`, 'error');
  } finally { picking = false; }
}

// Fallback folder browser: the server lists folders, because a web page cannot see real disk paths.
export async function openFolderDialog() {
  const pathEl = h('.fs-path');
  const list = h('.fs-list');
  const shortcuts = h('.fs-shortcuts');
  const count = h('.fs-count');
  const add = h('button.btn.btn-primary', { type: 'button', text: 'Add this folder' });
  const d = dialog('Add a music folder', shortcuts, pathEl, list, h('.dialog-foot', {}, count, add));
  let current = null;

  async function go(path) {
    let r;
    try { r = await api.fs(path); } catch (e) { return toast(`That folder cannot be opened: ${e.message}`, 'error'); }
    current = r.path;
    pathEl.textContent = r.path;
    fill(shortcuts, ...r.shortcuts.map((s) => h('button.btn.btn-small', { type: 'button', text: s.name, onclick: () => go(s.path) })));
    fill(list, 
      r.parent ? h('button.fs-item.up', { type: 'button', text: '↑ Up one level', onclick: () => go(r.parent) }) : null,
      ...r.dirs.map((name) => h('button.fs-item', { type: 'button', text: name, onclick: () => go(`${r.path}/${name}`) })),
      !r.dirs.length ? h('.fs-none', { text: 'No folders inside this one.' }) : null);
    count.textContent = r.media ? `${r.media} music or video file${r.media === 1 ? '' : 's'} directly in this folder. Subfolders are included too.` : 'Subfolders are included when you add a folder.';
    list.scrollTop = 0;
  }
  add.addEventListener('click', async () => {
    try {
      await api.addFolder(current);
      d.close();
      toast('Folder added. Reading your tracks…');
      setTimeout(refresh, 400);
    } catch (e) { toast(e.message, 'error'); }
  });
  go();
}

// ----- SoundCloud and the Downloads folder -----
const scLink = (u) => { try { return /(^|\.)soundcloud\.com$|^snd\.sc$/.test(new URL(u).hostname); } catch { return false; } };

export async function watchDownloads() {
  try {
    const r = await api.watchDownloads();
    if (r.cancelled) return false;
    toast(r.added ? 'Watching Downloads. New songs saved there join the library on their own.' : 'Downloads is already watched.');
    setTimeout(refresh, 400);
    return true;
  } catch (e) { toast(`Downloads could not be added: ${e.message}`, 'error'); return false; }
}

export async function openSoundCloud() {
  const server = !!api.capabilities.soundcloud;
  const url = h('input.search', { type: 'url', placeholder: 'https://soundcloud.com/artist/track', 'aria-label': 'SoundCloud link', required: true });
  const go = h('button.btn.btn-primary', { type: 'submit', text: server ? 'Download' : 'Open on SoundCloud' });
  const results = h('ul.sc-results', { 'aria-live': 'polite' });
  const connectBox = h('div');
  const d = dialog('SoundCloud',
    h('p', { text: server
      ? 'Paste a link to a track or playlist. Every track the artist lets you download is saved to your library. Tracks without downloads are skipped.'
      : 'Paste a link to a track. SoundCloud opens it; if the artist allows downloads, use More (⋯) → Download file. With Downloads watched, the song joins your library on its own.' }),
    h('form.sc-form', { onsubmit: (e) => { e.preventDefault(); run(); } }, url, go),
    results,
    connectBox,
    h('h3', { text: 'Downloads folder' }),
    h('p', { text: server
      ? 'Watch your Downloads folder and anything you save there from SoundCloud, or any other site, is added a few seconds after it finishes.'
      : 'Watch your Downloads folder and new songs saved there are added while BaezBeats is open (Chrome checks every 20 seconds). Chrome asks you to confirm the folder.' }),
    h('button.btn.btn-small', { type: 'button', text: 'Watch Downloads', onclick: watchDownloads }),
    h('p.note', { text: 'Only download music you have the right to play. SoundCloud lets you download a track only when its artist has switched downloads on.' }));

  async function run() {
    const link = url.value.trim();
    if (!scLink(link)) return toast('Paste a SoundCloud link, like https://soundcloud.com/artist/track', 'error');
    if (!server) { window.open(link, '_blank', 'noopener'); return; }
    go.disabled = true; go.textContent = 'Downloading…';
    fill(results, h('li.note', { text: 'Asking SoundCloud…' }));
    try {
      const r = await api.importSoundcloud(link);
      const label = { saved: 'Added', 'not-downloadable': 'Not downloadable', error: 'Failed' };
      fill(results, ...r.results.map((x) => h('li', { class: `sc-${x.status}` },
        h('span.sc-state', { text: label[x.status] }), h('span', { text: x.title }),
        x.reason && x.status === 'error' ? h('span.note', { text: ` (${x.reason})` }) : null)));
      if (!r.results.length) fill(results, h('li.note', { text: 'That playlist has no tracks.' }));
      const saved = r.results.filter((x) => x.status === 'saved').length;
      if (saved) { toast(`${saved} song${saved === 1 ? '' : 's'} saved from SoundCloud. Reading them now…`); url.value = ''; setTimeout(refresh, 600); }
    } catch (e) {
      fill(results, h('li.sc-error', { text: e.message }));
    } finally { go.disabled = false; go.textContent = 'Download'; }
  }

  // Mac app: SoundCloud only answers apps it knows, so the DJ registers one (free) and
  // pastes its two keys here once. They are kept in the library on this Mac.
  async function renderConnect() {
    if (!server) return;
    let s;
    try { s = await api.soundcloud(); } catch { return; }
    go.disabled = !s.connected;
    if (s.connected) {
      fill(connectBox, h('p.note', {}, `Connected. Songs are saved to ${s.folder}. `,
        h('button.linkish', { type: 'button', text: 'Disconnect', onclick: async () => { await api.connectSoundcloud('', ''); renderConnect(); } })));
      return;
    }
    const id = h('input.search', { 'aria-label': 'Client ID', autocomplete: 'off' });
    const secret = h('input.search', { type: 'password', 'aria-label': 'Client secret', autocomplete: 'off' });
    const save = h('button.btn.btn-small', { type: 'submit', text: 'Connect' });
    fill(connectBox,
      h('h3', { text: 'Connect SoundCloud (once)' }),
      h('p', {}, 'SoundCloud only lets registered apps download. Sign in at ',
        h('a', { href: 'https://soundcloud.com/you/apps', target: '_blank', rel: 'noopener', text: 'soundcloud.com/you/apps' }),
        ', register an app (any name, e.g. "BaezBeats"), then paste its two keys here. They stay on this Mac.'),
      h('form', { onsubmit: async (e) => {
        e.preventDefault();
        save.disabled = true; save.textContent = 'Checking…';
        try { await api.connectSoundcloud(id.value, secret.value); toast('SoundCloud connected.'); renderConnect(); }
        catch (err) { toast(err.message, 'error'); save.disabled = false; save.textContent = 'Connect'; }
      } },
        h('label.field', {}, h('span', { text: 'Client ID' }), id),
        h('label.field', {}, h('span', { text: 'Client secret' }), secret),
        save));
  }
  renderConnect();
  url.focus();
  return d;
}

const SHORTCUTS = [
  ['W / O', 'Play or pause deck A / B'],
  ['Q / I', 'Cue deck A / B (hold to preview)'],
  ['E / P', 'Sync deck A / B to the other deck'],
  ['1–4 / 7–0', 'Hot cues 1–4 on deck A / B'],
  ['A S / K L', 'Nudge deck A / B slower, faster (hold)'],
  ['Z X / N M', 'Loop 4 beats, exit loop on deck A / B'],
  ['↑ ↓', 'Move through the track list'],
  ['Shift ← / Shift →', 'Load the selected track to deck A / B'],
  ['/', 'Search the library'],
  ['Space', 'Start or stop the drum sequencer'],
];

export async function openSettings() {
  const fmtSize = (b) => (b > 1e9 ? `${(b / 1e9).toFixed(1)} GB` : `${Math.round(b / 1e6)} MB`);
  const s = (await api.state()).stems;

  // ----- audio outputs -----
  const masterSel = h('select.select', { 'aria-label': 'Speakers' });
  const modeSel = h('select.select', { 'aria-label': 'Headphone output' },
    h('option', { value: 'off', text: 'No separate headphone output' }),
    h('option', { value: 'split', text: 'Outputs 3–4 of the same sound card' }),
    h('option', { value: 'device', text: 'A second audio device' }));
  const phoneSel = h('select.select', { 'aria-label': 'Headphone device' });
  const audioNote = h('p.note');
  const namesBtn = h('button.btn.btn-small', { type: 'button', text: 'Show device names' });

  async function fillDevices() {
    const outs = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === 'audiooutput');
    const named = outs.some((d) => d.label);
    namesBtn.hidden = named;
    const opts = () => outs.map((d, i) => h('option', { value: d.deviceId || 'default', text: d.label || (i === 0 ? 'System default' : `Output ${i + 1}`) }));
    fill(masterSel, ...opts());
    fill(phoneSel, ...opts().filter((o) => o.value !== 'default'));
    masterSel.value = ctx.sinkId || 'default';
    if (masterSel.selectedIndex < 0) masterSel.selectedIndex = 0;
    modeSel.value = engine.cueMode;
    phoneSel.hidden = modeSel.value !== 'device';
    const ch = ctx.destination.maxChannelCount;
    audioNote.textContent = named
      ? `The current speaker output has ${ch} channel${ch === 1 ? '' : 's'}. Outputs 3–4 need a DJ sound card or controller with at least 4.`
      : 'Chrome hides device names until you allow microphone access once. BaezBeats does not record from it.';
  }
  namesBtn.addEventListener('click', async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      stream.getTracks().forEach((t) => t.stop());
      fillDevices();
    } catch { toast('Device names stay hidden without that permission. Outputs still work.', 'error'); }
  });
  masterSel.addEventListener('change', async () => {
    try { await engine.setMasterDevice(masterSel.value); await applyCue(); fillDevices(); } catch (e) { toast(`That output could not be used: ${e.message}`, 'error'); }
  });
  async function applyCue() {
    phoneSel.hidden = modeSel.value !== 'device';
    try {
      const got = await engine.route(modeSel.value, phoneSel.value);
      if (got !== modeSel.value) {
        toast(modeSel.value === 'split' ? 'This sound card has only 2 outputs, so headphones cannot use 3–4.' : 'Choose a headphone device.', 'error');
        modeSel.value = got;
      }
      localStorage.setItem('baezbeats.cue', JSON.stringify({ mode: got, device: phoneSel.value }));
    } catch (e) { toast(`Headphone output failed: ${e.message}`, 'error'); }
  }
  modeSel.addEventListener('change', applyCue);
  phoneSel.addEventListener('change', applyCue);

  // ----- stems -----
  const dirInput = h('input.search', { value: s.dir, 'aria-label': 'Stem storage folder' });
  const stemBody = !api.capabilities.stems
    ? [h('p', { text: 'Stem separation (vocals, melody, bass, drums) and Mashups are in the BaezBeats Mac app for now. They are coming to the web version later.' })]
    : s.installed
    ? [
      h('p', { text: `Stem separation is installed. Prepared stems use ${fmtSize(s.cacheBytes)} of disk (about 30 MB per track).` }),
      h('label.field', {}, h('span', { text: 'Store stems in' }), dirInput,
        h('button.btn.btn-small', { type: 'button', text: 'Save', onclick: async () => { try { await api.settings({ stemsDir: dirInput.value }); toast('Stem folder saved. Stems already prepared stay in the old folder.'); } catch (e) { toast(e.message, 'error'); } } })),
      h('button.btn.btn-small', { type: 'button', text: 'Delete all prepared stems', onclick: async () => { if (confirm('Delete all prepared stems? Your music files are not touched; stems can be prepared again later.')) { await api.clearStems(); await refresh(); toast('Prepared stems deleted'); } } }),
    ]
    : [
      h('p', { text: 'Stem separation (vocals, melody, bass, drums) is not installed yet. It needs about 1 GB of disk. To install it, open Terminal in the BaezBeats folder and run:' }),
      h('pre', { text: 'cd app.nosync && ./scripts/setup-stems.sh' }),
      h('p.note', { text: 'Then restart BaezBeats.' }),
    ];

  dialog('Settings',
    h('h3', { text: 'Sound outputs' }),
    h('label.field', {}, h('span', { text: 'Speakers' }), masterSel),
    h('label.field', {}, h('span', { text: 'Headphones' }), modeSel, phoneSel),
    h('.field', {}, namesBtn), audioNote,
    h('h3', { text: 'Stems' }), ...stemBody,
    h('h3', { text: 'Keyboard' }),
    h('table.keys', {}, ...SHORTCUTS.map(([k, what]) => h('tr', {}, h('td', {}, h('kbd', { text: k })), h('td', { text: what })))));
  fillDevices().then(() => {
    const saved = JSON.parse(localStorage.getItem('baezbeats.cue') || 'null');
    if (saved?.device && [...phoneSel.options].some((o) => o.value === saved.device)) phoneSel.value = saved.device;
  });
}
