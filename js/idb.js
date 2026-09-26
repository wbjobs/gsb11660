// IndexedDB 极简封装：kv 存储（心跳/锁状态快照）+ log 存储（事件审计）
export function openStore() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open('web-locks-demo', 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('kv')) db.createObjectStore('kv');
      if (!db.objectStoreNames.contains('log')) db.createObjectStore('log', { autoIncrement: true });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function tx(db, store, mode, fn) {
  return new Promise((resolve, reject) => {
    const t = db.transaction(store, mode);
    const req = fn(t.objectStore(store));
    t.oncomplete = () => resolve(req?.result);
    t.onerror = () => reject(t.error);
  });
}

export const kvSet = (db, key, val) => tx(db, 'kv', 'readwrite', (s) => s.put(val, key));
export const kvGet = (db, key) => tx(db, 'kv', 'readonly', (s) => s.get(key));
export const logAdd = (db, entry) => tx(db, 'log', 'readwrite', (s) => s.add(entry));
