// "Get music": a guided window for adding songs, built for someone who just wants it to work.
//   home        three big choices: music on this computer, SoundCloud, drag and drop
//   soundcloud  one click watches Downloads and opens SoundCloud; a picture guide shows the
//               two clicks on SoundCloud; each song that arrives is shown with Deck A/B buttons
import { h, fill, toast } from './controls.js';
import { api } from './api.js';
import { store, refresh } from './store.js';
import { dialog, addMusic, openSoundCloud } from './dialogs.js';
import { loadTrack } from './deck-ui.js';

let decks = [];
export function initGetMusic(d) { decks = d; }

const downloadsWatched = () => store.folders.some((f) => /(^|\/)Downloads$/.test(f));

export function openGetMusic(page = 'home') {
  const body = h('.gm');
  const d = dialog('Get music', body);
  d.classList.add('gm-dialog');
  let stopWatching = () => {};
  d.addEventListener('close', () => stopWatching());

  function home() {
    stopWatching();
    const tile = (title, text, onclick, icon) => h('button.gm-tile', { type: 'button', onclick },
      h('span.gm-icon', { html: icon, 'aria-hidden': 'true' }), h('span.gm-tile-title', { text: title }), h('span.gm-tile-text', { text }));
    fill(body,
      h('p.gm-lead', { text: 'Where are the songs?' }),
      h('.gm-tiles', {},
        tile('On this computer', 'A folder or drive with your music or music videos.', () => { d.close(); addMusic('folder'); }, ICON.folder),
        tile('From SoundCloud', 'We show you how, step by step. It takes two clicks on SoundCloud.', soundcloud, ICON.cloud),
        api.mode === 'browser'
          ? tile('Drag and drop', 'Drag a folder or songs from Finder or File Explorer onto the library.', dragHelp, ICON.drop)
          : tile('Single songs', 'Pick one or more song files.', () => { d.close(); addMusic('files'); }, ICON.note)));
  }

  function dragHelp() {
    fill(body,
      back(),
      h('p.gm-lead', { text: 'Drag your music in' }),
      h('ol.gm-steps', {},
        step('Open the folder with your songs', 'In Finder (Mac) or File Explorer (PC).'),
        step('Drag it onto the BaezBeats library', 'The track list at the bottom of the screen. Whole folders work.'),
        step('Done', 'Your songs appear in the list and are read on this computer. Nothing is uploaded.')),
      h('.gm-actions', {}, h('button.btn.btn-primary.gm-big', { type: 'button', text: 'Got it', onclick: () => d.close() })));
  }

  function soundcloud() {
    const search = h('input.search.gm-search', { type: 'search', placeholder: 'Song or artist (optional)', 'aria-label': 'Song or artist to look for on SoundCloud' });
    const start = h('button.btn.btn-primary.gm-big', { type: 'submit', text: 'Open SoundCloud' });
    const status = h('.gm-status', { role: 'status', 'aria-live': 'polite' });
    const arrived = h('ul.gm-arrived');
    let since = 0;

    fill(body,
      back(),
      h('p.gm-lead', { text: 'Songs from SoundCloud' }),
      h('form.gm-start', { onsubmit: (e) => { e.preventDefault(); go(); } }, search, start),
      h('p.note', { text: api.mode === 'browser'
        ? 'The first time, Chrome asks you to choose a folder: pick Downloads and click Select (then Allow).'
        : 'BaezBeats watches your Downloads folder, so anything you download shows up here by itself.' }),
      h('ol.gm-steps', {},
        step('Find a song on SoundCloud', 'Open the song’s own page (click its title).'),
        step('Click “More” under the waveform', 'It’s the button with three dots.', PIC.more),
        step('Click “Download file”', 'Your browser saves it to Downloads.', PIC.menu),
        step('It appears here by itself', api.mode === 'browser' ? 'Within about 20 seconds. Then load it on a deck.' : 'A few seconds later. Then load it on a deck.')),
      status, arrived,
      h('details.gm-help', {},
        h('summary', { text: 'There’s no “Download file”?' }),
        h('p', { text: 'Then the artist hasn’t allowed downloads for that song, and SoundCloud won’t give it out. Try another song: many DJs and producers mark tracks as free downloads. Some put a “Free Download” link in the description instead; follow it, and the file still lands in Downloads.' }),
        h('p', { text: 'Only play music you have the right to use.' })),
      api.capabilities.soundcloud
        ? h('details.gm-help', {},
          h('summary', { text: 'Advanced: download by pasting a link' }),
          h('p', { text: 'If you have SoundCloud app keys, BaezBeats can download allowed tracks and whole playlists from a pasted link.' }),
          h('button.btn.btn-small', { type: 'button', text: 'Paste a link', onclick: () => { d.close(); openSoundCloud(); } }))
        : null);

    function waiting() {
      fill(status, h('span.gm-pulse', { 'aria-hidden': 'true' }),
        h('span', { text: arrived.children.length ? 'Download another, or close this window.' : 'Waiting for your download…' }));
    }

    async function go() {
      // 1. make sure Downloads is watched (the browser version needs the visitor to pick it once)
      if (!downloadsWatched()) {
        try {
          const r = await api.watchDownloads();
          if (r.cancelled) return toast('Pick your Downloads folder so the songs can come in.', 'error');
          await refresh();
        } catch (e) { return toast(`Downloads could not be watched: ${e.message}`, 'error'); }
      }
      // 2. open SoundCloud
      const q = search.value.trim();
      since = since || Date.now() - 5000;
      window.open(q ? `https://soundcloud.com/search/sounds?q=${encodeURIComponent(q)}` : 'https://soundcloud.com/discover', '_blank', 'noopener');
      start.textContent = 'Open SoundCloud again';
      waiting();
    }

    // 3. show each song saved after the guide was started
    const shown = new Set();
    const onTrack = (e) => {
      const t = e.detail;
      if (!since || !t || shown.has(t.id) || !(t.mtime >= since)) return;
      shown.add(t.id);
      arrived.prepend(h('li.gm-got', {},
        h('span.gm-check', { text: '✓', 'aria-hidden': 'true' }),
        h('span.gm-got-name', { text: t.artist ? `${t.artist} – ${t.title}` : t.title }),
        ...decks.map((deck) => h('button.btn.btn-small', {
          type: 'button', text: `Deck ${deck.name}`, style: `--deck: var(--${deck.name.toLowerCase()})`,
          onclick: (ev) => { loadTrack(deck, store.tracks.get(t.id) || t); ev.target.classList.add('on'); },
        }))));
      toast(`Got it: ${t.title}`);
      waiting();
    };
    store.addEventListener('track', onTrack);
    stopWatching = () => store.removeEventListener('track', onTrack);
    search.focus();
  }

  const back = () => h('button.linkish.gm-back', { type: 'button', text: '← All choices', onclick: home });
  const step = (title, text, pic) => h('li.gm-step', {}, h('.gm-step-text', {}, h('strong', { text: title }), h('span', { text })), pic ? h('.gm-pic', { html: pic, 'aria-hidden': 'true' }) : null);

  if (page === 'soundcloud') soundcloud(); else home();
  return d;
}

// Simple drawings (not screenshots): the shape of the two buttons to look for.
const PIC = {
  more: `<svg viewBox="0 0 200 54" width="200" height="54"><rect x="1" y="1" width="198" height="52" rx="6" fill="#111318" stroke="#373d4c"/>
    <g fill="#5b6377">${Array.from({ length: 34 }, (_, i) => `<rect x="${8 + i * 5.5}" y="${14 - (i * 7 % 9)}" width="3" height="${8 + (i * 7 % 9) * 1.4}"/>`).join('')}</g>
    <rect x="8" y="32" width="38" height="16" rx="3" fill="#2a2f3b"/><rect x="50" y="32" width="38" height="16" rx="3" fill="#2a2f3b"/>
    <rect x="92" y="31" width="58" height="18" rx="3" fill="#2a2f3b" stroke="#ffa726" stroke-width="2"/>
    <text x="121" y="44" fill="#ece8df" font-size="11" text-anchor="middle" font-family="system-ui">••• More</text></svg>`,
  menu: `<svg viewBox="0 0 200 64" width="200" height="64"><rect x="1" y="1" width="150" height="62" rx="6" fill="#1e222b" stroke="#373d4c"/>
    <text x="12" y="18" fill="#98a0b0" font-size="11" font-family="system-ui">Add to Next up</text>
    <rect x="5" y="25" width="142" height="18" rx="3" fill="#2a2f3b" stroke="#ffa726" stroke-width="2"/>
    <text x="12" y="38" fill="#ece8df" font-size="11" font-family="system-ui">⤓ Download file</text>
    <text x="12" y="57" fill="#98a0b0" font-size="11" font-family="system-ui">Add to playlist</text></svg>`,
};
const ICON = {
  folder: '<svg viewBox="0 0 48 48" width="44" height="44"><path d="M5 13a3 3 0 0 1 3-3h11l4 4h17a3 3 0 0 1 3 3v19a3 3 0 0 1-3 3H8a3 3 0 0 1-3-3z" fill="none" stroke="currentColor" stroke-width="3"/></svg>',
  cloud: '<svg viewBox="0 0 48 48" width="44" height="44"><path d="M14 36h22a8 8 0 0 0 0-16 11 11 0 0 0-21-2 9 9 0 0 0-1 18z" fill="none" stroke="currentColor" stroke-width="3"/><path d="M24 22v10m-4-4 4 4 4-4" fill="none" stroke="currentColor" stroke-width="3"/></svg>',
  drop: '<svg viewBox="0 0 48 48" width="44" height="44"><rect x="6" y="6" width="36" height="36" rx="4" fill="none" stroke="currentColor" stroke-width="3" stroke-dasharray="6 4"/><path d="M24 14v18m-7-7 7 7 7-7" fill="none" stroke="currentColor" stroke-width="3"/></svg>',
  note: '<svg viewBox="0 0 48 48" width="44" height="44"><path d="M18 34V10l20-4v24" fill="none" stroke="currentColor" stroke-width="3"/><circle cx="13" cy="34" r="5" fill="none" stroke="currentColor" stroke-width="3"/><circle cx="33" cy="30" r="5" fill="none" stroke="currentColor" stroke-width="3"/></svg>',
};
