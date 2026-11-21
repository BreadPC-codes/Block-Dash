// IndexedDB storage for imported bike models (files can be large, so they do not go in
// localStorage). Works in Electron and in browsers.

const DB_NAME = 'roostmx';
const STORE = 'bikes';
let dbPromise = null;

function openDb() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') {
      reject(new Error('IndexedDB is not available'));
      return;
    }
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE, { keyPath: 'id' });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

function tx(mode, fn) {
  return openDb().then(
    (db) =>
      new Promise((resolve, reject) => {
        const t = db.transaction(STORE, mode);
        const store = t.objectStore(STORE);
        let result;
        const r = fn(store);
        if (r) r.onsuccess = () => (result = r.result);
        t.oncomplete = () => resolve(result);
        t.onerror = () => reject(t.error);
        t.onabort = () => reject(t.error);
      })
  );
}

/** record: { id, name, format, files: [{name, data(ArrayBuffer)}], config, created } */
export function saveBike(record) {
  return tx('readwrite', (s) => s.put(record));
}

export function getBike(id) {
  return tx('readonly', (s) => s.get(id));
}

export function deleteBike(id) {
  return tx('readwrite', (s) => s.delete(id));
}

/** List bikes without their file data. */
export async function listBikes() {
  const all = (await tx('readonly', (s) => s.getAll())) || [];
  return all.map((b) => ({ id: b.id, name: b.name, format: b.format, created: b.created, size: (b.files || []).reduce((a, f) => a + (f.data ? f.data.byteLength : 0), 0) }));
}

export async function updateBikeConfig(id, config, name) {
  const rec = await getBike(id);
  if (!rec) return;
  rec.config = config;
  if (name) rec.name = name;
  await saveBike(rec);
}
