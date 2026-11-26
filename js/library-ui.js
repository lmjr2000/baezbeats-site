// Library browser: folders, crates, search, sortable track list.
import { h, fill, fmtTime, toast } from './controls.js';
import { store, setCrates, refresh } from './store.js';
import { api } from './api.js';
import { loadTrack } from './deck-ui.js';
import { watchDownloads } from './dialogs.js';
import { openGetMusic } from './getmusic.js';

const COLS = [
  ['title', 'Title'], ['artist', 'Artist'], ['bpm', 'BPM'], ['camelot', 'Key'], ['duration', 'Length'], ['stems', 'Stems'],
];
const MAX_ROWS = 1500;

export function buildLibrary(decks, addMusic) {
  let view = 'all';            // 'all' | 'recent' | crate id
  let query = '', sortKey = 'artist', sortDir = 1;
  let selected = null, visible = [];

  const search = h('input.search', { type: 'search', placeholder: 'Search title, artist, key or BPM', 'aria-label': 'Search library' });
  search.addEventListener('input', () => { query = search.value.trim().toLowerCase(); render(); });
  const status = h('.lib-status', { role: 'status' });
  const side = h('nav.lib-side', { 'aria-label': 'Library sections' });
  const tbody = h('tbody');
  const headCells = COLS.map(([key, label]) => h('th', { scope: 'col', class: `col-${key}` },
    h('button', { type: 'button', text: label, onclick: () => { if (sortKey === key) sortDir = -sortDir; else { sortKey = key; sortDir = 1; } render(); } })));
  const table = h('table.tracks', {}, h('thead', {}, h('tr', {}, h('th.col-load', { scope: 'col', text: 'Load' }), ...headCells, h('th.col-x'))), tbody);
  const empty = h('.lib-empty');
  const scroller = h('.lib-scroll', { tabIndex: 0, 'aria-label': 'Tracks' }, table, empty);

  const watchingDownloads = () => store.folders.some((f) => /(^|\/)Downloads$/.test(f));
  // ----- sidebar -----
  function renderSide() {
    // don't rebuild while someone is typing a crate name
    if (side.contains(document.activeElement) && document.activeElement.tagName === 'INPUT') return;
    const item = (id, label, count, extra) => {
      const b = h('button.side-item', { type: 'button', class: view === id ? 'on' : '', onclick: () => { view = id; renderSide(); render(); } },
        h('span', { text: label }), count != null && h('span.count', { text: String(count) }));
      return h('.side-row', {}, b, extra);
    };
    const recent = [...store.tracks.values()].filter((t) => t.last_played).length;
    const crateRows = store.crates.map((c) => {
      const row = item(c.id, c.name, c.trackIds.length, h('button.side-x', {
        type: 'button', text: '×', title: `Delete crate ${c.name}`,
        onclick: async () => { if (confirm(`Delete the crate "${c.name}"? The tracks stay in your library.`)) { if (view === c.id) view = 'all'; setCrates(await api.removeCrate(c.id)); render(); } },
      }));
      row.addEventListener('dragover', (e) => { if (e.dataTransfer.types.includes('text/baezbeats-track')) { e.preventDefault(); row.classList.add('drop'); } });
      row.addEventListener('dragleave', () => row.classList.remove('drop'));
      row.addEventListener('drop', async (e) => {
        e.preventDefault(); row.classList.remove('drop');
        const id = Number(e.dataTransfer.getData('text/baezbeats-track'));
        if (id) { setCrates(await api.addToCrate(c.id, id)); toast(`Added to ${c.name}`); }
      });
      return row;
    });
    const newCrate = h('form.new-crate', {
      onsubmit: async (e) => {
        e.preventDefault();
        const input = e.target.elements.name;
        if (!input.value.trim()) return;
        try { setCrates(await api.addCrate(input.value)); input.value = ''; } catch (err) { toast(err.message, 'error'); }
      },
    }, h('input', { name: 'name', placeholder: 'New crate name', 'aria-label': 'New crate name' }), h('button.btn.btn-small', { type: 'submit', text: 'Add' }));

    fill(side, 
      item('all', 'All tracks', store.tracks.size),
      item('recent', 'Recently played', recent),
      h('.side-head', { text: 'Crates' }),
      ...crateRows,
      store.crates.length ? h('.side-hint', { text: 'Drag tracks onto a crate to add them.' }) : null,
      newCrate,
      h('.side-head', { text: 'Add music' }),
      ...store.folders.map((f) => h('.side-row.folder', {},
        h('span.folder-path', { text: f.split('/').filter(Boolean).pop() || f, title: f }),
        h('button.side-x', {
          type: 'button', text: '×', title: `Remove ${f} from the library`,
          onclick: async () => { if (confirm(`Remove this folder from the library?\n${f}\n\nYour files are not deleted.`)) { await api.removeFolder(f); refresh(); } },
        }))),
      h('button.btn.btn-small', { type: 'button', text: 'Add folder', title: 'Choose a folder or drive in Finder', onclick: () => addMusic('folder') }),
      h('button.btn.btn-small', { type: 'button', text: 'Add files', title: 'Choose individual songs or videos in Finder', onclick: () => addMusic('files') }),
      h('button.btn.btn-small', { type: 'button', text: 'SoundCloud', title: 'Get songs from SoundCloud links', onclick: () => openGetMusic('soundcloud') }),
      watchingDownloads() ? null : h('button.btn.btn-small', { type: 'button', text: 'Watch Downloads', title: 'New songs saved in Downloads join the library on their own', onclick: () => watchDownloads() }),
      store.tracks.size ? h('button.btn.btn-small', { type: 'button', text: 'Rescan', title: 'Look for new or changed files', onclick: () => api.rescan() }) : null,
    );
  }

  // ----- track list -----
  function stemsCell(t) {
    const job = store.stems.jobs[t.id];
    if (t.stems === 1) return h('span.tag.ready', { text: 'Ready', title: 'Stems are prepared for this track' });
    if (job) return h('span.tag', { text: job.state === 'queued' ? 'Queued' : `${Math.round((job.progress || 0) * 100)}%` });
    if (!store.stems.installed) return h('span.dim', { text: '–' });
    return h('button.link', { type: 'button', text: 'Prepare', title: 'Separate vocals, melody, bass and drums (takes two to three minutes per track)', onclick: (e) => { e.stopPropagation(); api.prepareStems(t.id).catch((err) => toast(err.message, 'error')); } });
  }

  function currentTracks() {
    let list = [...store.tracks.values()];
    if (view === 'recent') list = list.filter((t) => t.last_played);
    else if (view !== 'all') {
      const crate = store.crates.find((c) => c.id === view);
      const ids = new Set(crate ? crate.trackIds : []);
      list = list.filter((t) => ids.has(t.id));
    }
    if (query) {
      const words = query.split(/\s+/);
      list = list.filter((t) => {
        const hay = `${t.title} ${t.artist} ${t.file} ${t.key || ''} ${t.camelot || ''} ${t.bpm ? Math.round(t.bpm) : ''}`.toLowerCase();
        return words.every((w) => hay.includes(w));
      });
    }
    const val = (t) => {
      if (view === 'recent' && sortKey === 'artist') return -t.last_played;
      const v = t[sortKey];
      if (sortKey === 'camelot') return v ? parseInt(v, 10) * 2 + (v.endsWith('B') ? 1 : 0) : 999;
      return typeof v === 'string' ? v.toLowerCase() : v ?? (sortDir > 0 ? Infinity : -Infinity);
    };
    list.sort((a, b) => {
      const x = val(a), y = val(b);
      return (x < y ? -1 : x > y ? 1 : (a.title || '').localeCompare(b.title || '')) * sortDir;
    });
    return list;
  }

  let queued = false;
  function render() {
    if (queued) return;
    queued = true;
    requestAnimationFrame(() => { queued = false; renderNow(); });
  }

  function renderNow() {
    visible = currentTracks();
    headCells.forEach((th, i) => th.setAttribute('aria-sort', COLS[i][0] === sortKey ? (sortDir > 0 ? 'ascending' : 'descending') : 'none'));
    const inCrate = typeof view === 'number';
    const rows = visible.slice(0, MAX_ROWS).map((t) => {
      const tr = h('tr', { draggable: true, class: t.id === selected ? 'selected' : '', 'data-id': t.id },
        h('td.col-load', {},
          h('button.load.a', { type: 'button', text: 'A', title: 'Load to deck A', onclick: (e) => { e.stopPropagation(); loadTrack(decks[0], t); } }),
          h('button.load.b', { type: 'button', text: 'B', title: 'Load to deck B', onclick: (e) => { e.stopPropagation(); loadTrack(decks[1], t); } })),
        h('td.col-title', {}, h('span', { text: t.title || t.file }), t.has_video ? h('span.tag.video', { text: 'Video' }) : null),
        h('td.col-artist', { text: t.artist || '' }),
        h('td.col-bpm', { text: t.bpm ? t.bpm.toFixed(1) : t.analyzed === 0 ? '…' : '–' }),
        h('td.col-camelot', { text: t.camelot || (t.analyzed === 0 ? '…' : '–'), title: t.key || '' }),
        h('td.col-duration', { text: fmtTime(t.duration) }),
        h('td.col-stems', {}, stemsCell(t)),
        h('td.col-x', {}, inCrate ? h('button.side-x', {
          type: 'button', text: '×', title: 'Remove from this crate',
          onclick: async (e) => { e.stopPropagation(); setCrates(await api.removeFromCrate(view, t.id)); render(); },
        }) : null));
      tr.addEventListener('click', () => select(t.id));
      tr.addEventListener('dblclick', () => loadTrack(decks.find((d) => !d.playing && !d.track) || decks.find((d) => !d.playing) || decks[0], t));
      tr.addEventListener('dragstart', (e) => {
        e.dataTransfer.setData('text/baezbeats-track', String(t.id));
        e.dataTransfer.effectAllowed = 'copy';
      });
      return tr;
    });
    fill(tbody, ...rows);
    table.hidden = !visible.length;
    empty.hidden = !!visible.length;
    if (!visible.length) {
      if (!store.folders.length && !store.tracks.size) {
        fill(empty, 
          h('p.empty-title', { text: 'Add your music to start' }),
          h('p', { text: api.mode === 'browser'
            ? 'Choose the folder or drive that holds your music videos, or drop it right here. Your music stays on this computer: BaezBeats reads it in Chrome and nothing is uploaded.'
            : 'Choose the folder or drive that holds your MP4s, or pick individual files. A Finder window opens to choose them. Files are read where they are; nothing is copied or changed.' }),
          h('.empty-actions', {},
            h('button.btn.btn-primary', { type: 'button', text: 'Get music', onclick: () => openGetMusic() }),
            h('button.btn', { type: 'button', text: 'Add folder', onclick: () => addMusic('folder') }),
            h('button.btn', { type: 'button', text: 'Add files', onclick: () => addMusic('files') })));
      } else if (store.scan.running) fill(empty, h('p', { text: 'Reading your music folder…' }));
      else if (query) fill(empty, h('p', { text: `No tracks match "${query}".` }));
      else if (typeof view === 'number') fill(empty, h('p', { text: 'This crate is empty. Drag tracks onto its name to fill it.' }));
      else if (view === 'recent') fill(empty, h('p', { text: 'Tracks you play will show up here.' }));
      else fill(empty, h('p', { text: 'No playable music was found in your folders.' }));
    }
    renderStatus();
  }

  function renderStatus() {
    const s = store.scan;
    let text = `${visible.length} track${visible.length === 1 ? '' : 's'}`;
    if (visible.length > MAX_ROWS) text += ` (showing the first ${MAX_ROWS}; search to narrow down)`;
    if (s.running) text = `Reading files ${s.done} of ${s.found}…`;
    else if (store.pending) text += `, working out tempo and key for ${store.pending} more`;
    status.textContent = text;
  }

  function select(id, scroll = false) {
    selected = id;
    for (const tr of tbody.children) {
      const on = Number(tr.dataset.id) === id;
      tr.classList.toggle('selected', on);
      if (on && scroll) tr.scrollIntoView({ block: 'nearest' });
    }
  }

  store.addEventListener('tracks', render);
  store.addEventListener('stems', render);
  store.addEventListener('scan', renderStatus);
  store.addEventListener('crates', () => { renderSide(); render(); });
  store.addEventListener('tracks', renderSide);
  renderSide(); render();

  const bar = h('.lib-bar', {}, search, status);
  const el = h('.library', {}, side, h('.lib-main', {}, bar, scroller));
  return {
    el, search, bar,
    move(delta) {
      if (!visible.length) return;
      const i = visible.findIndex((t) => t.id === selected);
      const n = Math.max(0, Math.min(Math.min(visible.length, MAX_ROWS) - 1, i < 0 ? 0 : i + delta));
      select(visible[n].id, true);
    },
    selectedTrack: () => store.tracks.get(selected),
    // what the list is showing right now (crate / search applied), in order
    visibleTracks: () => visible.slice(),
    viewName: () => (view === 'all' ? (query ? `search "${query}"` : 'all tracks') : view === 'recent' ? 'recently played' : (store.crates.find((c) => c.id === view)?.name || 'crate')),
  };
}
