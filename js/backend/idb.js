// Small promise wrapper around IndexedDB: the browser version's library database.
//
// Stores:
//   tracks    one record per song (same fields as the Mac app's SQLite rows), keyPath id
//   peaks     waveform data per track id (kept apart because it is large)
//   roots     music folders and single files the visitor added (file-system handles)
//   crates    { id, name, trackIds }
//   settings  key -> value
const NAME = 'baezbeats', VERSION = 1;
let opening = null;

function open() {
  opening ||= new Promise((resolve, reject) => {
    const r = indexedDB.open(NAME, VERSION);
    r.onupgradeneeded = () => {
      const db = r.result;
      const tracks = db.createObjectStore('tracks', { keyPath: 'id', autoIncrement: true });
      tracks.createIndex('fileKey', 'fileKey', { unique: true });
      tracks.createIndex('root', 'root');
      db.createObjectStore('peaks');
      db.createObjectStore('roots', { keyPath: 'id', autoIncrement: true });
      db.createObjectStore('crates', { keyPath: 'id', autoIncrement: true });
      db.createObjectStore('settings');
    };
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
    r.onblocked = () => reject(new Error('Close other BaezBeats tabs and reload.'));
  });
  return opening;
}

const done = (req) => new Promise((resolve, reject) => {
  req.onsuccess = () => resolve(req.result);
  req.onerror = () => reject(req.error);
});

async function store(name, mode = 'readonly') {
  return (await open()).transaction(name, mode).objectStore(name);
}

export const idb = {
  get: async (name, key) => done((await store(name)).get(key)),
  all: async (name) => done((await store(name)).getAll()),
  byIndex: async (name, index, value) => done((await store(name)).index(index).get(value)),
  allByIndex: async (name, index, value) => done((await store(name)).index(index).getAll(value)),
  // returns the key (the new id when the store assigns one)
  put: async (name, value, key) => done((await store(name, 'readwrite')).put(value, key)),
  del: async (name, key) => done((await store(name, 'readwrite')).delete(key)),
};
