// Keeps BaezBeats working without internet once it has been opened (parties, bad Wi-Fi).
// Network first, so an updated app is picked up straight away; the cached copy is only
// used when the network is not there. The build script fills in VERSION and ASSETS.
const VERSION = 'bf130a9';
const ASSETS = ["./", "index.html", "js/api.js", "js/autodj.js", "js/automix.js", "js/backend/browser.js", "js/backend/idb.js", "js/backend/server.js", "js/backend/worker.js", "js/clubfx.js", "js/controls.js", "js/deck-ui.js", "js/deck-worklet.js", "js/deck.js", "js/dialogs.js", "js/djmodes.js", "js/energy.js", "js/engine.js", "js/getmusic.js", "js/library-ui.js", "js/main.js", "js/mashups.js", "js/mixer-ui.js", "js/sequencer.js", "js/setplan.js", "js/shared/analysis/analysis.js", "js/shared/analysis/dsp.js", "js/shared/analysis/structure.js", "js/shared/names.js", "js/store.js", "js/video.js", "js/waveform.js", "logo.svg", "output.html", "styles.css", "vendor/soundtouch.LICENSE.txt", "vendor/soundtouch.js"];
const CACHE = `baezbeats-${VERSION}`;

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(ASSETS)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys()
    .then((keys) => Promise.all(keys.filter((k) => k.startsWith('baezbeats-') && k !== CACHE).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== location.origin) return;
  e.respondWith(
    fetch(req)
      .then((res) => {
        if (res.ok) { const copy = res.clone(); caches.open(CACHE).then((c) => c.put(req, copy)); }
        return res;
      })
      .catch(() => caches.match(req, { ignoreSearch: true }).then((hit) => hit || Response.error())),
  );
});
