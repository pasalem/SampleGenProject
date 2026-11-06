// Minimal IndexedDB wrapper. Collection items are stored by `key` (scryfallId|finish).
const DB_NAME = 'mtg-collection';
const STORE = 'items';
const VERSION = 1;

let dbPromise;
function open() {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, VERSION);
      req.onupgradeneeded = () => {
        if (!req.result.objectStoreNames.contains(STORE)) {
          req.result.createObjectStore(STORE, { keyPath: 'key' });
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
  return dbPromise;
}

function run(mode, fn) {
  return open().then(
    (db) =>
      new Promise((resolve, reject) => {
        const tx = db.transaction(STORE, mode);
        const out = fn(tx.objectStore(STORE));
        tx.oncomplete = () => resolve(out instanceof IDBRequest ? out.result : undefined);
        tx.onerror = () => reject(tx.error);
        tx.onabort = () => reject(tx.error);
      })
  );
}

export const getAll = () => run('readonly', (s) => s.getAll());
export const putMany = (items) => run('readwrite', (s) => { items.forEach((i) => s.put(i)); });
export const remove = (key) => run('readwrite', (s) => { s.delete(key); });
export const clear = () => run('readwrite', (s) => { s.clear(); });
