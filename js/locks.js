// 两套锁适配器，接口一致：
//   acquire(resource, mode, { timeout, signal }) -> Promise<{ release() }>
import { kvGet, kvSet } from './idb.js';

// mode: 'exclusive' | 'shared'
// 超时 → reject(DOMException name='TimeoutError')；取消 → name='AbortError'

// ---------- 原生 Web Locks API 适配器 ----------
export class NativeLockAdapter {
  constructor() { this.kind = 'Web Locks API（原生）'; }

  acquire(resource, mode, { timeout = 0, signal } = {}) {
    if (signal?.aborted) return Promise.reject(new DOMException('锁请求已取消', 'AbortError'));
    return new Promise((resolve, reject) => {
      const controller = new AbortController();
      let finished = false;
      let resolveRelease;
      let timer = null;

      const fail = (name, message) => {
        if (finished) return;
        finished = true;
        if (timer) clearTimeout(timer);
        signal?.removeEventListener('abort', onUserAbort);
        reject(new DOMException(message, name));
      };
      const onUserAbort = () => { timedOut = false; controller.abort(); };
      let timedOut = false;
      if (timeout > 0) timer = setTimeout(() => { timedOut = true; controller.abort(); }, timeout);
      signal?.addEventListener('abort', onUserAbort, { once: true });

      navigator.locks.request(resource, { mode, signal: controller.signal }, (lock) => {
        // 进入回调即代表拿到锁（未使用 ifAvailable，lock 恒非空）
        return new Promise((done) => {
          if (finished) { done(); return; }
          finished = true;
          if (timer) clearTimeout(timer);
          signal?.removeEventListener('abort', onUserAbort);
          resolveRelease = done;
          resolve({ release: () => resolveRelease?.() });
        });
      }).catch(() => {
        fail(timedOut ? 'TimeoutError' : 'AbortError',
             timedOut ? '锁等待超时' : '锁请求已取消');
      });
    });
  }

  async query() { return navigator.locks.query(); }
}

// ---------- BroadcastChannel 协调器（降级方案） ----------
const PEER_TTL = 4000; // 心跳超时即认为标签页崩溃
class FallbackCoordinator {
  constructor(adapter) {
    this.a = adapter;
    this.holders = new Map(); // reqId -> { resource, mode, tabId }
    this.queues = new Map(); // resource -> [{ reqId, tabId, mode }]
    this.ready = this.init();
  }
  async init() {
    const saved = await kvGet(this.a.store, 'lock-state').catch(() => null);
    if (saved) {
      // 仅恢复当前仍存活标签页的记录；崩溃者的锁交给租约过期回收
      const alive = (id) => this.a.peers.has(id) &&
        Date.now() - this.a.peers.get(id).lastSeen < PEER_TTL;
      for (const [reqId, h] of saved.holders ?? []) if (alive(h.tabId)) this.holders.set(reqId, h);
      for (const [res, q] of saved.queues ?? [])
        this.queues.set(res, q.filter((e) => alive(e.tabId)));
    }
  }
  persist() { kvSet(this.a.store, 'lock-state', {
    holders: [...this.holders], queues: [...this.queues], at: Date.now(),
  }); }

  handleRequest(msg) {
    if (this.holders.has(msg.reqId)) return; // 重发去重
    const q = this.queues.get(msg.resource) ?? [];
    if (!q.some((e) => e.reqId === msg.reqId))
      q.push({ reqId: msg.reqId, tabId: msg.from, mode: msg.mode });
    this.queues.set(msg.resource, q);
    this.process(msg.resource);
  }
  handleCancel(msg) {
    const q = this.queues.get(msg.resource);
    if (q && q.some((e) => e.reqId === msg.reqId)) {
      this.queues.set(msg.resource, q.filter((e) => e.reqId !== msg.reqId));
      this.persist();
    }
  }
  handleRelease(msg) {
    const h = this.holders.get(msg.reqId);
    if (h) { this.holders.delete(msg.reqId); this.process(h.resource); this.persist(); }
  }

  // 严格 FIFO 授权：队头是独占则必须无人持有；队头是共享且当前无独占持有者时，
  // 可连续放行队首的一串共享请求。新的共享请求排在独占之后 → 不饿死独占。
  process(resource) {
    const q = this.queues.get(resource);
    if (!q) return;
    const held = [...this.holders.values()].filter((h) => h.resource === resource);
    while (q.length) {
      const head = q[0];
      if (head.mode === 'exclusive' ? held.length
        : held.some((h) => h.mode === 'exclusive')) break;
      q.shift();
      const entry = { reqId: head.reqId, resource, mode: head.mode, tabId: head.tabId };
      held.push(entry);
      this.holders.set(head.reqId, entry);
      this.a.deliver(head.tabId, { type: 'lock-grant', reqId: head.reqId });
    }
    this.persist();
  }

  // 租约检查：持有者心跳消失（崩溃/被强杀）→ 自动回收
  tick(peers) {
    const now = Date.now();
    const alive = (id) => id === this.a.tabId ||
      (peers.has(id) && now - peers.get(id).lastSeen < PEER_TTL);
    let changed = false;
    for (const [reqId, h] of [...this.holders]) {
      if (!alive(h.tabId)) {
        this.holders.delete(reqId);
        changed = true;
        this.a.onEvent(`租约过期：回收崩溃标签页 ${h.tabId.slice(0, 4)} 的 ${h.resource}`, 'warn');
      }
    }
    for (const [res, q] of this.queues) {
      const nq = q.filter((e) => alive(e.tabId));
      if (nq.length !== q.length) { this.queues.set(res, nq); changed = true; }
    }
    if (changed) for (const res of this.queues.keys()) this.process(res);
  }
}

export class FallbackLockAdapter {
  constructor(bus, store, tabId, joinedAt, onEvent = () => {}) {
    this.kind = 'BroadcastChannel 模拟（降级）';
    this.bus = bus; this.store = store;
    this.tabId = tabId; this.joinedAt = joinedAt;
    this.onEvent = onEvent;
    this.peers = new Map([[tabId, { joinedAt, lastSeen: Date.now() }]]);
    this.coordinatorId = null;
    this.isCoordinator = false;
    this.coordinator = null;
    this.pending = new Map(); // reqId -> { resolve, resource }
    this.held = new Map();    // reqId -> { resource, mode }
    this.bus.subscribe((m) => this._onMessage(m));
    setInterval(() => this._heartbeat(), 1000);
    setInterval(() => this._tick(), 500);
    this._heartbeat();
  }

  _heartbeat() {
    this.peers.get(this.tabId).lastSeen = Date.now();
    this.bus.post({ type: 'hb', tabId: this.tabId, joinedAt: this.joinedAt,
      held: [...this.held.keys()] });
    kvSet(this.store, `hb:${this.tabId}`, { joinedAt: this.joinedAt, ts: Date.now() }).catch(() => {});
  }

  _tick() {
    const now = Date.now();
    for (const [id, p] of this.peers)
      if (id !== this.tabId && now - p.lastSeen > PEER_TTL) this.peers.delete(id);
    // 选举：(joinedAt, tabId) 最小的存活标签页成为协调者
    let coord = this.tabId;
    let coordAt = this.joinedAt;
    for (const [id, p] of this.peers) {
      if (p.joinedAt < coordAt || (p.joinedAt === coordAt && id < coord)) {
        coord = id; coordAt = p.joinedAt;
      }
    }
    if (coord !== this.coordinatorId) {
      this.coordinatorId = coord;
      this.isCoordinator = coord === this.tabId;
      this.coordinator = null;
      if (this.isCoordinator) {
        this.coordinator = new FallbackCoordinator(this);
        this.coordinator.ready.then(() => {
          this._resendPending();
          this.onEvent(`本标签页当选锁协调者`);
        });
      } else {
        this._resendPending(); // 旧协调者可能已崩溃，待处理请求重发给新协调者
      }
      this.onEvent(`协调者切换为 ${coord.slice(0, 4)}${this.isCoordinator ? '（本标签页）' : ''}`);
    }
    if (this.coordinator) this.coordinator.tick(this.peers);
  }

  acquire(resource, mode, { timeout = 0, signal } = {}) {
    if (signal?.aborted) return Promise.reject(new DOMException('锁请求已取消', 'AbortError'));
    const reqId = crypto.randomUUID();
    return new Promise((resolve, reject) => {
      let timer = null;
      const cleanup = () => {
        if (timer) clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
        this.pending.delete(reqId);
      };
      const onAbort = () => {
        cleanup();
        this._send(this.coordinatorId, { type: 'lock-cancel', reqId, resource });
        reject(new DOMException('锁请求已取消', 'AbortError'));
      };
      if (timeout > 0) timer = setTimeout(() => {
        cleanup();
        this._send(this.coordinatorId, { type: 'lock-cancel', reqId, resource });
        reject(new DOMException('锁等待超时', 'TimeoutError'));
      }, timeout);
      signal?.addEventListener('abort', onAbort, { once: true });
      this.pending.set(reqId, {
        entry: { resource, mode },
        resolve: () => {
          cleanup();
          this.held.set(reqId, { resource, mode });
          resolve({ release: () => this._release(reqId) });
        },
      });
      this._send(this.coordinatorId, { type: 'lock-request', reqId, resource, mode });
    });
  }

  _resendPending() {
    for (const [reqId, p] of this.pending)
      this._send(this.coordinatorId, { type: 'lock-request', reqId, ...p.entry });
  }

  _release(reqId) {
    if (!this.held.has(reqId)) return;
    this.held.delete(reqId);
    this._send(this.coordinatorId, { type: 'lock-release', reqId });
  }

  deliver(tabId, msg) {
    if (tabId !== this.tabId) { this.bus.post({ ...msg, to: tabId }); return; }
    if (msg.type === 'lock-grant' && this.pending.has(msg.reqId))
      this.pending.get(msg.reqId).resolve();
  }

  _send(to, msg) {
    if (!to) return;
    if (to === this.tabId) { this._route({ ...msg, from: this.tabId }); return; }
    this.bus.post({ ...msg, to });
  }

  _onMessage(m) {
    if (m._src === this.bus.id) return;
    if (m.type === 'hb') {
      this.peers.set(m.tabId, { joinedAt: m.joinedAt, lastSeen: Date.now(), held: m.held });
      return;
    }
    if (m.to && m.to !== this.tabId) return;
    this._route(m);
  }

  _route(m) {
    if (m.type === 'lock-grant') {
      if (this.pending.has(m.reqId)) this.pending.get(m.reqId).resolve();
    } else if (this.isCoordinator && this.coordinator) {
      const route = () => {
        if (m.type === 'lock-request') this.coordinator.handleRequest(m);
        else if (m.type === 'lock-cancel') this.coordinator.handleCancel(m);
        else if (m.type === 'lock-release') this.coordinator.handleRelease(m);
      };
      this.coordinator.ready.then(route);
    }
  }
}
