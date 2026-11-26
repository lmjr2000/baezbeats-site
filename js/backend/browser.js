// Browser backend: BaezBeats as a website. Everything the Mac app's server does happens in
// the page instead, and the music never leaves the visitor's computer:
//   - music is read from folders or files the visitor picks (File System Access API);
//     Chrome remembers the permission, or asks once per visit with a single click
//   - the library lives in IndexedDB (see idb.js)
//   - songs are decoded with Chrome's own decoder (it pulls the audio out of music videos)
//   - tempo, key, structure and waveforms are worked out in a background worker using the
//     same analysis code as the Mac app (web/js/shared/analysis)
// Stem separation is not available here yet; it is in the Mac app.
import { idb } from './idb.js';
import { parseFilename, MEDIA_EXT, VIDEO_EXT, extOf } from '../shared/names.js';
import { ANALYSIS_VERSION } from '../shared/analysis/analysis.js';
import { autoCues } from '../shared/analysis/structure.js';

const SR = 44100, ARATE = 22050;
const events = new EventTarget();
const emit = (type, data = {}) => events.dispatchEvent(new CustomEvent('ev', { detail: { type, ...data } }));
const scanState = { running: false, found: 0, done: 0 };
const NO_STEMS = 'Stem separation is in the BaezBeats Mac app for now. It is coming to the web version later.';

// ---------- background worker ----------
let worker = null, jobId = 0;
const waiting = new Map();
function work(op, left, right) {
  if (!worker) {
    worker = new Worker(new URL('./worker.js', import.meta.url), { type: 'module' });
    worker.onmessage = (e) => {
      const w = waiting.get(e.data.id);
      waiting.delete(e.data.id);
      if (!w) return;
      if (e.data.ok) w.resolve(e.data); else w.reject(new Error(e.data.error));
    };
    worker.onerror = (e) => {
      for (const w of waiting.values()) w.reject(new Error(e.message || 'The analysis worker stopped'));
      waiting.clear(); worker = null;
    };
  }
  const id = ++jobId;
  return new Promise((resolve, reject) => {
    waiting.set(id, { resolve, reject });
    worker.postMessage({ id, op, left, right }, [left.buffer, right.buffer]);
  });
}

// ---------- files and permissions ----------
async function permitted(handle, ask = false) {
  if (!handle.queryPermission) return true;                    // e.g. the private origin file system
  const opts = { mode: 'read' };
  if ((await handle.queryPermission(opts)) === 'granted') return true;
  return ask ? (await handle.requestPermission(opts)) === 'granted' : false;
}

async function fileOf(track) {
  const root = await idb.get('roots', track.root);
  if (!root) throw new Error('This song is no longer in the library.');
  if (!(await permitted(root.handle))) throw new Error('Reconnect your music first: use the Reconnect button at the top of the page.');
  if (root.type === 'file') return root.handle.getFile();
  let dir = root.handle;
  const parts = track.rel.split('/');
  for (const p of parts.slice(0, -1)) dir = await dir.getDirectoryHandle(p);
  const fh = await dir.getFileHandle(parts[parts.length - 1]);
  return fh.getFile();
}

// Decodes a whole file at the given sample rate. Chrome picks the audio out of video files.
async function decode(file, rate, onRead, signal) {
  let bytes;
  if (onRead && file.stream) {
    const reader = file.stream().getReader();
    const chunks = [];
    let got = 0;
    for (;;) {
      if (signal?.aborted) { reader.cancel(); throw new DOMException('Aborted', 'AbortError'); }
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value); got += value.length;
      onRead(got / file.size);
    }
    bytes = new Uint8Array(got);
    let o = 0;
    for (const c of chunks) { bytes.set(c, o); o += c.length; }
    bytes = bytes.buffer;
  } else bytes = await file.arrayBuffer();
  if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
  const ctx = new OfflineAudioContext(2, 1, rate);
  try {
    return await ctx.decodeAudioData(bytes);
  } catch {
    throw new Error(`${file.name} has no audio this browser can play.`);
  }
}
const channels = (ab) => {
  const l = ab.getChannelData(0).slice();
  const r = ab.numberOfChannels > 1 ? ab.getChannelData(1).slice() : l.slice();
  return [l, r];
};

// Length and whether there is a picture, read from the file's header (fast).
const probeEl = document.createElement('video');
probeEl.muted = true; probeEl.preload = 'metadata';
function probe(file) {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(file);
    let settled = false;
    const finish = (r) => {
      if (settled) return; settled = true;
      clearTimeout(timer); probeEl.removeAttribute('src'); probeEl.load(); URL.revokeObjectURL(url);
      resolve(r);
    };
    probeEl.onloadedmetadata = () => finish({ duration: Number.isFinite(probeEl.duration) ? probeEl.duration : 0, video: probeEl.videoWidth > 0 });
    probeEl.onerror = () => finish(null);
    const timer = setTimeout(() => finish(null), 4000);
    probeEl.src = url;
  });
}

// ---------- library records ----------
const pick = (t) => ({ ...t, missing: t.missing ? 1 : 0 });
async function rootName(root) {
  const roots = await idb.all('roots');
  const same = roots.filter((r) => r.type === root.type && r.name === root.name).sort((a, b) => a.id - b.id);
  const i = same.findIndex((r) => r.id === root.id);
  return i > 0 ? `${root.name} (${i + 1})` : root.name;
}
async function crateList() {
  return (await idb.all('crates')).sort((a, b) => a.name.localeCompare(b.name));
}
async function emitTrack(id) {
  const t = await idb.get('tracks', id);
  if (t) emit('track', { track: pick(t) });
}

// ---------- scanning ----------
async function* walk(dir, prefix = '') {
  for await (const [name, h] of dir.entries()) {
    if (name.startsWith('.')) continue;
    if (h.kind === 'directory') { if (!/\.(download|crdownload|part)$/i.test(name)) yield* walk(h, `${prefix}${name}/`); }
    else if (MEDIA_EXT.includes(extOf(name))) yield { rel: `${prefix}${name}`, handle: h };
  }
}

async function scanRoot(root) {
  const seen = new Set();
  const entries = [];
  if (root.type === 'file') entries.push({ rel: root.name, handle: root.handle });
  else for await (const e of walk(root.handle)) entries.push(e);
  scanState.found += entries.length;
  emit('scan', { ...scanState });
  const label = await rootName(root);
  for (const { rel, handle } of entries) {
    const fileKey = `${root.id}:${rel}`;
    seen.add(fileKey); looked.add(fileKey);
    try {
      const file = await handle.getFile();
      const old = await idb.byIndex('tracks', 'fileKey', fileKey);
      if (old && old.size === file.size && old.mtime === file.lastModified) {
        if (old.missing) { old.missing = 0; await idb.put('tracks', old); emit('track', { track: pick(old) }); }
      } else {
        const info = await probe(file);
        if (!info && !old) { scanState.done++; continue; }     // not something the browser can play
        const guess = parseFilename(file.name);
        const t = old || { fileKey, root: root.id, rel, added_at: Date.now(), play_count: 0, cues: [], cues_auto: 0, stems: 0 };
        Object.assign(t, {
          path: `${label}/${rel}`, file: file.name, size: file.size, mtime: file.lastModified, missing: 0,
          title: guess.title || file.name, artist: guess.artist || '',
          duration: info?.duration || 0, has_video: info ? (info.video ? 1 : 0) : VIDEO_EXT.includes(extOf(file.name)) ? 1 : 0,
          analyzed: 0,
        });
        t.id = await idb.put('tracks', t);
        emit('track', { track: pick(t) });
      }
    } catch (err) {
      console.warn('BaezBeats: skipped', rel, err.message);
    }
    scanState.done++;
    if (scanState.done % 10 === 0) emit('scan', { ...scanState });
  }
  // songs that were in this folder before but are not any more
  for (const t of await idb.allByIndex('tracks', 'root', root.id)) {
    if (!seen.has(t.fileKey) && !t.missing) { t.missing = 1; await idb.put('tracks', t); }
  }
}

// Folders are checked every 20 seconds while the page is open, so a song saved into one
// (e.g. a SoundCloud download landing in Downloads) joins the library on its own.
// Chrome has no folder-change events, so this compares names against what was seen before.
const looked = new Set();          // every file key a scan has looked at, playable or not
async function watchTick() {
  if (scanState.running || document.hidden) return;
  const changed = [];
  for (const root of await idb.all('roots')) {
    if (root.type !== 'dir' || !(await permitted(root.handle))) continue;
    const known = new Set();
    for (const t of await idb.allByIndex('tracks', 'root', root.id)) if (!t.missing) known.add(t.fileKey);
    try {
      for await (const { rel } of walk(root.handle)) {
        const k = `${root.id}:${rel}`;
        if (!known.has(k) && !looked.has(k)) { changed.push(root.id); break; }
      }
    } catch { /* folder went away (drive unplugged) */ }
  }
  if (changed.length) await scanAll(changed);
}
setInterval(() => { watchTick().catch(() => {}); }, 20000);

async function scanAll(only = null) {
  if (scanState.running) return;
  Object.assign(scanState, { running: true, found: 0, done: 0 });
  emit('scan', { ...scanState });
  try {
    for (const root of await idb.all('roots')) {
      if (only && !only.includes(root.id)) continue;
      if (!(await permitted(root.handle))) continue;
      await scanRoot(root);
    }
  } finally {
    scanState.running = false;
    emit('scan', { ...scanState });
    queueAnalysis();
  }
}

async function addRoot(handle) {
  for (const r of await idb.all('roots')) {
    if (r.handle.isSameEntry && (await r.handle.isSameEntry(handle))) { await scanAll([r.id]); return 0; }
  }
  const root = { type: handle.kind === 'directory' ? 'dir' : 'file', name: handle.name, handle, added_at: Date.now() };
  root.id = await idb.put('roots', root);
  await scanAll([root.id]);
  return 1;
}

// ---------- analysis queue (one song at a time; songs on a deck go first) ----------
let busy = null, paused = false;              // paused: music needs reconnecting
const priority = [];
const failedNow = new Set();                  // songs that could not be read this visit
const finished = new Map();          // id -> [resolve]

async function pendingCount() {
  return (await idb.all('tracks')).filter((t) => !t.missing && t.analyzed === 0).length;
}

async function analyzeOne(id) {
  const t = await idb.get('tracks', id);
  if (!t) return;
  try {
    const ab = await decode(await fileOf(t), ARATE);
    const [l, r] = channels(ab);
    const { result: m, duration } = await work('analyze', l, r);
    const now = await idb.get('tracks', id);
    Object.assign(now, {
      bpm: m.bpm || null, first_beat: m.firstBeat || 0, key: m.key, camelot: m.camelot, loud: m.loud ?? null,
      snare_period: m.snarePeriod || null, snare_first: m.snareFirst || 0, structure: m.structure || null,
      peaks_rate: m.peaksRate, analyzed: 1, analysis_v: ANALYSIS_VERSION, duration: now.duration || duration,
    });
    const untouched = !(now.cues || []).some((c) => c != null) || now.cues_auto === 1;
    const auto = autoCues(m.structure);
    if (untouched && auto && auto.some((c) => c != null)) { now.cues = auto; now.cues_auto = 1; }
    await idb.put('peaks', m.peaks, id);
    await idb.put('tracks', now);
  } catch (err) {
    console.warn(`BaezBeats: analysis failed for ${t.title}:`, err.message);
    const now = await idb.get('tracks', id);
    if (/Reconnect/.test(err.message)) paused = true;          // try again after Reconnect
    else if (/NotFound|could not be found/i.test(err.name + err.message)) failedNow.add(id);
    else if (now) { now.analyzed = -1; await idb.put('tracks', now); }
  }
  await emitTrack(id);
}

async function nextJob() {
  if (busy) return;
  let id = priority.shift();
  if (id === undefined && !paused) {
    const t = (await idb.all('tracks')).find((x) => !x.missing && x.analyzed === 0 && !failedNow.has(x.id));
    id = t?.id;
  }
  if (id === undefined) { emit('analysis', { pending: 0 }); return; }
  busy = id;
  emit('analysis', { pending: await pendingCount() });
  await analyzeOne(id);
  for (const f of finished.get(id) || []) f();
  finished.delete(id);
  busy = null;
  setTimeout(nextJob, 50);
}
function queueAnalysis() { nextJob(); }

async function analyzeNow(id) {
  const t = await idb.get('tracks', id);
  if (!t || t.analyzed !== 0) return;
  await new Promise((resolve) => {
    if (!finished.has(id)) finished.set(id, []);
    finished.get(id).push(resolve);
    if (busy !== id && !priority.includes(id)) priority.unshift(id);
    nextJob();
  });
}

// Songs analysed by an older version of the analysis are done again.
(async () => {
  for (const t of await idb.all('tracks')) {
    if (t.analyzed !== 0 && (t.analysis_v || 1) < ANALYSIS_VERSION) { t.analyzed = 0; await idb.put('tracks', t); }
  }
  queueAnalysis();
})();

// ---------- the API the app uses (same shape as the server backend) ----------
const ACCEPT = {
  'audio/*': MEDIA_EXT.filter((e) => !VIDEO_EXT.includes(e)),
  'video/*': VIDEO_EXT,
};

export const api = {
  mode: 'browser',
  capabilities: { stems: false, nativePicker: true, soundcloud: false },

  async state() {
    const roots = await idb.all('roots');
    const needs = [];
    for (const r of roots) if (!(await permitted(r.handle))) needs.push(r.id);
    return {
      folders: await Promise.all(roots.filter((r) => r.type === 'dir').map(rootName)),
      tracks: (await idb.all('tracks')).filter((t) => !t.missing).map(pick)
        .sort((a, b) => (a.artist || '').localeCompare(b.artist || '') || (a.title || '').localeCompare(b.title || '')),
      crates: await crateList(),
      scan: { ...scanState },
      pending: await pendingCount(),
      stems: { installed: false, jobs: {}, cacheBytes: 0, dir: '' },
      needsPermission: needs.length,
    };
  },

  // Opens Chrome's folder or file chooser and adds what was picked.
  async pick(kind) {
    try {
      if (kind === 'files') {
        const handles = await window.showOpenFilePicker({ multiple: true, id: 'baezbeats-music', types: [{ description: 'Music and music videos', accept: ACCEPT }] });
        let added = 0;
        for (const h of handles) added += await addRoot(h);
        return { added: added || handles.length, kind };
      }
      const dir = await window.showDirectoryPicker({ id: 'baezbeats-music', mode: 'read' });
      await addRoot(dir);
      return { added: 1, kind };
    } catch (err) {
      if (err.name === 'AbortError') return { cancelled: true };
      throw err;
    }
  },
  // Folders or files dropped onto the page (or any other file-system handle).
  async addHandles(handles) {
    let added = 0;
    for (const h of handles) added += await addRoot(h);
    return { added };
  },
  // Asks Chrome again for access to music added on an earlier visit (needs a click).
  async reconnect() {
    let ok = 0;
    for (const r of await idb.all('roots')) if (await permitted(r.handle, true)) ok++;
    paused = false; failedNow.clear();
    await scanAll();
    return { ok };
  },
  addFolder: async () => { throw new Error('Use Add folder to choose a folder.'); },
  fs: async () => { throw new Error('Not available in the browser version.'); },
  async removeFolder(name) {
    for (const r of await idb.all('roots')) {
      if ((await rootName(r)) !== name) continue;
      for (const t of await idb.allByIndex('tracks', 'root', r.id)) {
        await idb.del('tracks', t.id); await idb.del('peaks', t.id);
        for (const c of await idb.all('crates')) {
          if (c.trackIds.includes(t.id)) { c.trackIds = c.trackIds.filter((x) => x !== t.id); await idb.put('crates', c); }
        }
      }
      await idb.del('roots', r.id);
    }
    return { ok: true };
  },
  async rescan() { scanAll(); return { ok: true }; },
  // Chrome can't open Downloads by itself; the chooser starts there and the visitor confirms.
  async watchDownloads() {
    try {
      const dir = await window.showDirectoryPicker({ id: 'baezbeats-downloads', startIn: 'downloads', mode: 'read' });
      return { ok: true, added: !!(await addRoot(dir)), path: dir.name };
    } catch (err) {
      if (err.name === 'AbortError') return { cancelled: true };
      throw err;
    }
  },

  async analysis(id) {
    await analyzeNow(id);
    const t = await idb.get('tracks', id);
    if (!t) throw new Error('Track not found');
    return {
      bpm: t.bpm, firstBeat: t.first_beat, key: t.key, camelot: t.camelot, analyzed: t.analyzed,
      loud: t.loud, snarePeriod: t.snare_period, snareFirst: t.snare_first,
      structure: t.structure || null, cues: t.cues || [], cuesAuto: t.cues_auto === 1,
      peaksRate: t.peaks_rate, peaks: (await idb.get('peaks', id)) || null,
    };
  },
  async saveTrack(id, { cues, bpm, firstBeat } = {}) {
    const t = await idb.get('tracks', id);
    if (!t) throw new Error('Track not found');
    if (cues !== undefined) { t.cues = cues; t.cues_auto = 0; }   // cues set by hand are the DJ's own
    if (bpm > 0) t.bpm = bpm;
    if (firstBeat !== undefined) t.first_beat = firstBeat;
    await idb.put('tracks', t);
    return pick(t);
  },
  async played(id) {
    const t = await idb.get('tracks', id);
    if (!t) return { ok: false };
    t.last_played = Date.now(); t.play_count = (t.play_count || 0) + 1;
    await idb.put('tracks', t);
    emit('track', { track: pick(t) });
    return { ok: true };
  },

  prepareStems: async () => { throw new Error(NO_STEMS); },
  removeStems: async () => ({ ok: true }),
  clearStems: async () => ({ ok: true }),
  settings: async () => ({ ok: true }),

  async addCrate(name) {
    name = String(name || '').trim();
    if (!name) throw new Error('Give the crate a name');
    await idb.put('crates', { name, trackIds: [] });
    return crateList();
  },
  async removeCrate(id) { await idb.del('crates', Number(id)); return crateList(); },
  async addToCrate(id, trackId) {
    const c = await idb.get('crates', Number(id));
    if (c && !c.trackIds.includes(Number(trackId))) { c.trackIds.push(Number(trackId)); await idb.put('crates', c); }
    return crateList();
  },
  async removeFromCrate(id, trackId) {
    const c = await idb.get('crates', Number(id));
    if (c) { c.trackIds = c.trackIds.filter((x) => x !== Number(trackId)); await idb.put('crates', c); }
    return crateList();
  },

  // Song audio as interleaved 16-bit stereo PCM at 44.1 kHz (what the deck plays).
  async pcm(track, onProgress, signal) {
    const file = await fileOf(track);
    const ab = await decode(file, SR, (p) => onProgress?.(0.85 * p), signal);
    onProgress?.(0.92);
    const [l, r] = channels(ab);
    const { result } = await work('interleave', l, r);
    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
    onProgress?.(1);
    return result;
  },
  stemPcm: async () => { throw new Error(NO_STEMS); },
  // A temporary link to the video file on disk; released when the deck changes song.
  videoUrl: async (track) => URL.createObjectURL(await fileOf(track)),
  releaseVideoUrl: (url) => { if (url && url.startsWith('blob:')) URL.revokeObjectURL(url); },
};

export function listen(handler) {
  const fn = (e) => handler(e.detail);
  events.addEventListener('ev', fn);
  return { close: () => events.removeEventListener('ev', fn) };
}
