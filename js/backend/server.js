// Server backend: the Mac app, where a local Node server reads the music folder, decodes
// audio with ffmpeg, keeps the library in SQLite and runs stem separation.
const SR = 44100;

async function call(method, url, body) {
  const res = await fetch(url, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

export const api = {
  mode: 'server',
  capabilities: { stems: true, nativePicker: true, soundcloud: true },
  state: () => call('GET', '/api/state'),
  fs: (path) => call('GET', `/api/fs${path ? `?path=${encodeURIComponent(path)}` : ''}`),
  pick: (kind) => call('POST', '/api/pick', { kind }),
  addFolder: (path) => call('POST', '/api/folders', { path }),
  removeFolder: (path) => call('DELETE', '/api/folders', { path }),
  rescan: () => call('POST', '/api/scan'),
  watchDownloads: () => call('POST', '/api/watch-downloads'),
  soundcloud: () => call('GET', '/api/soundcloud'),
  connectSoundcloud: (clientId, clientSecret) => call('PUT', '/api/soundcloud', { clientId, clientSecret }),
  importSoundcloud: (url) => call('POST', '/api/soundcloud/import', { url }),
  analysis: (id) => call('GET', `/api/tracks/${id}/analysis`),
  saveTrack: (id, data) => call('PUT', `/api/tracks/${id}`, data),
  played: (id) => call('POST', `/api/tracks/${id}/played`),
  prepareStems: (id) => call('POST', `/api/tracks/${id}/stems`),
  removeStems: (id) => call('DELETE', `/api/tracks/${id}/stems`),
  clearStems: () => call('DELETE', '/api/stems'),
  settings: (data) => call('PUT', '/api/settings', data),
  addCrate: (name) => call('POST', '/api/crates', { name }),
  removeCrate: (id) => call('DELETE', `/api/crates/${id}`),
  addToCrate: (id, trackId) => call('POST', `/api/crates/${id}/tracks`, { trackId }),
  removeFromCrate: (id, trackId) => call('DELETE', `/api/crates/${id}/tracks/${trackId}`),
  // Song audio as interleaved 16-bit stereo PCM at 44.1 kHz (what the deck plays).
  pcm: (track, onProgress, signal) => fetchPcm(`/api/tracks/${track.id}/pcm`, onProgress, signal),
  stemPcm: (track, name, signal) => fetchPcm(`/api/tracks/${track.id}/stems/${name}/pcm`, null, signal),
  // Address the video element plays from; release() is for backends that make temporary links.
  videoUrl: async (track) => `/api/tracks/${track.id}/video`,
  releaseVideoUrl: () => {},
};

// Live updates (scan progress, analysis results, stem jobs).
async function fetchPcm(url, onProgress, signal) {
  const res = await fetch(url, { signal });
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || `Could not load audio (${res.status})`);
  const expected = (Number(res.headers.get('X-Duration')) || 0) * SR * 4;
  const reader = res.body.getReader();
  const chunks = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value); total += value.length;
    if (expected) onProgress?.(Math.min(1, total / expected));
  }
  total -= total % 4;
  const bytes = new Uint8Array(total);
  let o = 0;
  for (const c of chunks) { bytes.set(c.subarray(0, Math.min(c.length, total - o)), o); o += c.length; if (o >= total) break; }
  if (!total) throw new Error('This file has no audio that can be decoded');
  return bytes.buffer;
}

export function listen(handler) {
  const es = new EventSource('/api/events');
  es.onmessage = (e) => handler(JSON.parse(e.data));
  return es;
}
