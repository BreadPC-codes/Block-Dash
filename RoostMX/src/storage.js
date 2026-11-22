// IndexedDB storage for imported bike models and imported tracks (files can be large, so
// they do not go in localStorage). Works in Electron and in browsers.

const DB_NAME = 'roostmx';
const STORE = 'bikes';
const TRACKS = 'tracks'; // full imported track records (terrain grid, centre line, ...)
const TRACK_INDEX = 'trackIndex'; // small summaries + thumbnail, for the track list
let dbPromise = null;

function openDb() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') {
      reject(new Error('IndexedDB is not available'));
      return;
    }
    const req = indexedDB.open(DB_NAME, 2);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE, { keyPath: 'id' });
      if (!db.objectStoreNames.contains(TRACKS)) db.createObjectStore(TRACKS, { keyPath: 'id' });
      if (!db.objectStoreNames.contains(TRACK_INDEX)) db.createObjectStore(TRACK_INDEX, { keyPath: 'id' });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
    req.onblocked = () => reject(new Error('The game is open in another window; close it to update the saved data.'));
  });
  dbPromise.catch(() => { dbPromise = null; });
  return dbPromise;
}

function tx(mode, fn, stores = STORE) {
  return openDb().then(
    (db) =>
      new Promise((resolve, reject) => {
        const t = db.transaction(stores, mode);
        let result;
        const r = fn(Array.isArray(stores) ? stores.map((n) => t.objectStore(n)) : t.objectStore(stores));
        if (r) r.onsuccess = () => (result = r.result);
        t.oncomplete = () => resolve(result);
        t.onerror = () => reject(t.error);
        t.onabort = () => reject(t.error || new Error('Saving failed (the disk may be full).'));
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

// ---------------------------------------------------------------------------------
// imported tracks

/** Save a full record and its listing entry together. */
export function saveTrackRecord(record, summary) {
  return tx('readwrite', ([full, index]) => { full.put(record); index.put(summary); }, [TRACKS, TRACK_INDEX]);
}

export function getTrackRecord(id) {
  return tx('readonly', (s) => s.get(id), TRACKS);
}

/** Listing entries only (no terrain data). */
export async function listTrackSummaries() {
  return (await tx('readonly', (s) => s.getAll(), TRACK_INDEX)) || [];
}

export function deleteTrackRecord(id) {
  return tx('readwrite', ([full, index]) => { full.delete(id); index.delete(id); }, [TRACKS, TRACK_INDEX]);
}

/** Change settings of a stored track (scale, surface, name) in both stores. */
export async function updateTrackRecord(id, changes) {
  const rec = await getTrackRecord(id);
  if (!rec) return null;
  Object.assign(rec, changes);
  const sums = await listTrackSummaries();
  const sum = sums.find((t) => t.id === id) || { id };
  Object.assign(sum, changes);
  await saveTrackRecord(rec, sum);
  return rec;
}
