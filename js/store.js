// store.js — IndexedDB 事件日志持久化（刷新后历史仍在，跨标签页各自一份）。

const DB_NAME = 'web-locks-demo';
const STORE = 'events';

function open() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        const os = db.createObjectStore(STORE, { keyPath: 'id', autoIncrement: true });
        os.createIndex('ts', 'ts');
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export class EventStore {
  async init() {
    try {
      this.db = await open();
    } catch (e) {
      this.db = null; // IndexedDB 不可用时静默降级为仅内存展示
      console.warn('IndexedDB 不可用，事件日志不持久化', e);
    }
  }

  log(type, detail) {
    const ev = { ts: Date.now(), type, detail };
    if (!this.db) return Promise.resolve(ev);
    return new Promise((resolve) => {
      const tx = this.db.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).add(ev);
      tx.oncomplete = () => resolve(ev);
      tx.onerror = () => resolve(ev);
    });
  }

  recent(limit = 150) {
    if (!this.db) return Promise.resolve([]);
    return new Promise((resolve) => {
      const out = [];
      const tx = this.db.transaction(STORE, 'readonly');
      const cursorReq = tx.objectStore(STORE).index('ts').openCursor(null, 'prev');
      cursorReq.onsuccess = () => {
        const cursor = cursorReq.result;
        if (cursor && out.length < limit) {
          out.push(cursor.value);
          cursor.continue();
        } else {
          resolve(out);
        }
      };
      cursorReq.onerror = () => resolve(out);
    });
  }

  clear() {
    if (!this.db) return Promise.resolve();
    return new Promise((resolve) => {
      const tx = this.db.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).clear();
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
    });
  }
}
