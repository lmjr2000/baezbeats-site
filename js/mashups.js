// Mashups tab: which songs' vocals would sit well over the beat that is playing now.
// A fit needs the tempo within 6% (the vocal is time-stretched to the beat) and a key that
// is the same or next door on the Camelot wheel after a shift of at most 2 semitones.
import { h, fill, toast } from './controls.js';
import { mashupFit } from './setplan.js';
import { store } from './store.js';
import { api } from './api.js';

export function buildMashups(decks, automix, library) {
  const head = h('.adj-now');
  const tbody = h('tbody');
  const table = h('table.tracks', {}, h('thead', {}, h('tr', {},
    h('th', { text: 'Vocals from' }), h('th.col-artist', { text: 'Artist' }), h('th.col-bpm', { text: 'BPM' }),
    h('th.col-camelot', { text: 'Key' }), h('th.mash-fit', { text: 'Fit' }), h('th.mash-act', { text: '' }))), tbody);
  const empty = h('.lib-empty');
  const foot = h('.adj-foot', { text: 'Mashups use the stems (vocals, melody, bass, drums) that BaezBeats separates for a song. Preparing a song takes two to three minutes and about 30 MB.' });
  const el = h('.autodj.mashups', {}, head, h('.lib-scroll.adj-scroll', {}, table, empty), h('.adj-footrow', {}, foot));

  let shownKey = '';
  function paint(force = false) {
    if (el.hidden && !force) return;
    const cur = decks.find((d) => d.playing && d.track);
    const base = cur
      ? { title: cur.track.title, bpm: cur.effectiveBpm, camelot: cur.keyCamelot, id: cur.track.id }
      : (() => { const t = library.selectedTrack(); return t ? { title: t.title, bpm: t.bpm, camelot: t.camelot, id: t.id } : null; })();
    const jobs = store.stems.jobs;
    const key = JSON.stringify([base && [base.id, Math.round(base.bpm * 10), base.camelot], !!cur, automix.running, jobs,
      [...store.tracks.values()].filter((t) => t.stems === 1).map((t) => t.id)]);
    if (key === shownKey && !force) return;
    shownKey = key;

    if (!base || !base.bpm) {
      head.textContent = '';
      table.hidden = true; empty.hidden = false;
      fill(empty, h('p.empty-title', { text: 'Mash two songs together' }),
        h('p', { text: "Play a song (or select one in the Library). This tab then lists the songs whose vocals fit over its beat, and mixes one in for you: its hook vocals over the current beat, then its own beat drops in." }));
      return;
    }
    head.textContent = cur
      ? `Vocals that fit over ${base.title} (${base.bpm.toFixed(0)} BPM, key ${base.camelot || 'unknown'}).`
      : `Vocals that would fit over ${base.title} (${base.bpm.toFixed(0)} BPM, key ${base.camelot || 'unknown'}). Play it to mash one in.`;

    const rows = [...store.tracks.values()]
      .filter((t) => t.id !== base.id && t.bpm)
      .map((t) => ({ t, fit: mashupFit(base, t) }))
      .filter((x) => x.fit)
      .sort((a, b) => (b.t.stems === 1) - (a.t.stems === 1) || a.fit.score - b.fit.score);

    fill(tbody, ...rows.slice(0, 100).map(({ t, fit }) => {
      const pct = fit.tempoChange * 100;
      const fitText = `${fit.shift ? `key ${fit.shift > 0 ? '+' : ''}${fit.shift}` : 'same key'}, tempo ${pct >= 0 ? '+' : ''}${pct.toFixed(1)}%`;
      const job = jobs[t.id];
      let action;
      if (t.stems === 1) {
        action = h('button.btn.btn-small', {
          type: 'button', text: 'Mash in now', disabled: !cur || automix.running,
          title: cur ? `Bring ${t.title}'s hook vocals in over the current beat` : 'Play a song first',
          onclick: () => automix.start('mashup', t),
        });
      } else if (job) {
        action = h('span.tag', { text: job.state === 'queued' ? 'Waiting to separate' : `Separating ${Math.round((job.progress || 0) * 100)}%` });
      } else if (!store.stems.installed) {
        action = h('span.dim', { text: 'Stems not installed' });
      } else {
        action = h('button.btn.btn-small', {
          type: 'button', text: 'Prepare stems', title: 'Separate this song into vocals, melody, bass and drums (2 to 3 minutes)',
          onclick: () => api.prepareStems(t.id).catch((e) => toast(e.message, 'error')),
        });
      }
      return h('tr', {},
        h('td', { text: t.title || t.file }),
        h('td.col-artist', { text: t.artist || '' }),
        h('td.col-bpm', { text: t.bpm.toFixed(0) }),
        h('td.col-camelot', { text: t.camelot || '–' }),
        h('td.mash-fit', {}, h('span.tag', { class: fit.score < 0.5 ? 'ready' : '', text: fitText })),
        h('td.mash-act', {}, action));
    }));
    table.hidden = !rows.length; empty.hidden = !!rows.length;
    if (!rows.length) {
      fill(empty, h('p', { text: `No song in the library fits over this beat. A mashup needs a song within about 6% of ${base.bpm.toFixed(0)} BPM (or half or double that) in a key close to ${base.camelot || 'this one'}.` }));
    }
  }

  store.addEventListener('stems', () => paint());
  store.addEventListener('tracks', () => paint());
  for (const d of decks) for (const ev of ['state', 'load', 'analysis', 'tempo']) d.addEventListener(ev, () => paint());
  setInterval(() => paint(), 1500);
  return { el, paint: () => paint(true) };
}
