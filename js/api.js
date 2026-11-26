// Chooses where the library and audio come from:
//  - "server": the Mac app (a local Node server, with stem separation)
//  - "browser": the website, where everything runs in the page and music is read from a
//    folder the visitor picks (Chrome / Edge File System Access API)
// The hosted website sets <meta name="baezbeats-mode" content="browser">; otherwise the
// app asks for /api/state and uses the server if one answers.
async function detect() {
  const forced = document.querySelector('meta[name="baezbeats-mode"]')?.content;
  if (forced) return forced;
  try {
    const res = await fetch('/api/state', { headers: { Accept: 'application/json' } });
    if (res.ok && (res.headers.get('content-type') || '').includes('json')) return 'server';
  } catch { /* no server */ }
  return 'browser';
}

export const MODE = await detect();
const backend = await import(MODE === 'server' ? './backend/server.js' : './backend/browser.js');
export const api = backend.api;
export const listen = backend.listen;
