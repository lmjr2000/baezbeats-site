// Shared library state, kept fresh by the server's event stream.
import { api, listen } from './api.js';

export const store = Object.assign(new EventTarget(), {
  tracks: new Map(),
  crates: [],
  folders: [],
  scan: { running: false, found: 0, done: 0 },
  pending: 0,
  stems: { installed: false, jobs: {}, cacheBytes: 0, dir: '' },
});

const fire = (type, detail) => store.dispatchEvent(new CustomEvent(type, { detail }));

export async function refresh() {
  const s = await api.state();
  store.tracks = new Map(s.tracks.map((t) => [t.id, t]));
  store.crates = s.crates; store.folders = s.folders; store.scan = s.scan; store.pending = s.pending;
  store.stems = s.stems;
  store.needsPermission = s.needsPermission || 0;   // browser version: music to reconnect
  fire('tracks'); fire('crates'); fire('scan'); fire('stems'); fire('permission');
}

export function setCrates(crates) { store.crates = crates; fire('crates'); }

export function startLive() {
  let wasScanning = false;
  listen((ev) => {
    if (ev.type === 'track' && ev.track) {
      const old = store.tracks.get(ev.track.id);
      if (ev.track.missing) store.tracks.delete(ev.track.id);
      else store.tracks.set(ev.track.id, old ? Object.assign(old, ev.track) : ev.track);
      fire('track', store.tracks.get(ev.track.id) || ev.track);
      fire('tracks');
    } else if (ev.type === 'scan') {
      store.scan = ev;
      if (wasScanning && !ev.running) refresh();
      wasScanning = ev.running;
      fire('scan');
    } else if (ev.type === 'analysis') {
      store.pending = ev.pending; fire('scan');
    } else if (ev.type === 'stems') {
      if (ev.state === 'queued' || ev.state === 'running') store.stems.jobs[ev.id] = { state: ev.state, progress: ev.progress || 0 };
      else delete store.stems.jobs[ev.id];
      fire('stems', ev);
    }
  });
}
