// backend-broadcast.js — 当浏览器不支持 Web Locks API 时的降级实现。
// 原理：
//  - 所有标签页通过 BroadcastChannel 通信，存活集合中 id 最小者当选"协调者"；
//  - 协调者维护每把锁的 FIFO 等待队列与持有者集合，严格按队首兼容性授予
//    （独占需空无持有者；共享需无独占持有者 —— 队首阻塞保证公平、防止饿死）；
//  - 协调者宕机 → 幸存的 id 最小者接任，并向全员 resync 重建锁状态；
//  - 持有者/等待者宕机 → 心跳租约过期后被协调者回收，锁自动释放；
//  - 超时与取消：请求方本地判定后通知协调者出队，超时则进入降级执行。

let reqSeq = 0;

export class BroadcastLockBackend {
  constructor(cluster, emit) {
    this.cluster = cluster;
    this.emit = emit;
    this.name = 'BroadcastChannel 模拟（降级）';

    this.locks = new Map(); // 仅协调者使用：lock -> {holders: Map, queue: []}
    this.myReqs = new Map(); // reqId -> 本地请求记录
    this.isCoordinator = false;
    this.settleUntil = 0;

    cluster.onMessage((msg) => this._onMessage(msg));
    cluster.onPeerChange(() => this._elect());
    this._elect();
  }

  // ---------- 客户端 API ----------

  acquire({ lock, mode = 'exclusive', holdMs = 4000, timeoutMs = 5000 }) {
    const tab = this.cluster.identity;
    const reqId = `B${tab.name.slice(4)}-${Date.now().toString(36)}-${++reqSeq}`;
    let state = 'pending';
    let resolveAcquired, resolveDone;
    const acquired = new Promise((res) => (resolveAcquired = res));
    const done = new Promise((res) => (resolveDone = res));

    const rec = {
      reqId, lock, mode, holdMs, timeoutMs,
      enqueuedAt: Date.now(),
      get state() { return state; },
      onGranted: () => {
        if (state !== 'pending') return;
        state = 'held';
        resolveAcquired('held');
        if (holdMs > 0) holdTimer = setTimeout(() => handle.release(), holdMs);
      },
    };
    this.myReqs.set(reqId, rec);

    let holdTimer = null;
    const timeoutTimer = timeoutMs > 0
      ? setTimeout(async () => {
          if (state !== 'pending') return;
          state = 'degraded';
          this._ctl('lock-ctl-cancel', { reqId });
          this.emit('timeout', { reqId, lock, mode, tab, timeoutMs });
          this.emit('degraded-start', { reqId, lock, mode, tab, holdMs });
          resolveAcquired('degraded');
          await sleep(holdMs > 0 ? holdMs : 2000);
          this.myReqs.delete(reqId);
          this.emit('degraded-end', { reqId, lock, mode, tab });
          resolveDone('degraded');
        }, timeoutMs)
      : null;

    const handle = {
      reqId, lock, mode,
      acquired, done,
      get state() { return state; },
      release: () => {
        if (state !== 'held') return;
        state = 'released';
        if (holdTimer) clearTimeout(holdTimer);
        this._ctl('lock-ctl-release', { reqId, lock });
        this.myReqs.delete(reqId);
        resolveDone('released');
      },
      cancel: () => {
        if (state !== 'pending') return;
        state = 'cancelled';
        if (timeoutTimer) clearTimeout(timeoutTimer);
        this._ctl('lock-ctl-cancel', { reqId });
        this.myReqs.delete(reqId);
        this.emit('cancel', { reqId, lock, mode, tab });
        resolveAcquired('cancelled');
        resolveDone('cancelled');
      },
    };

    this.emit('request', { reqId, lock, mode, tab, holdMs, timeoutMs });
    this._ctl('lock-ctl-request', { reqId, lock, mode, holdMs, timeoutMs, enqueuedAt: rec.enqueuedAt });
    return handle;
  }

  // ---------- 内部 ----------

  _ctl(type, data) { this.cluster.send(type, data); }

  _onMessage(msg) {
    if (msg.type === 'lock-event' && msg.event === 'grant') {
      const rec = this.myReqs.get(msg.reqId);
      if (rec) rec.onGranted();
      return;
    }
    if (msg.type === 'peer-crashed') {
      if (this.isCoordinator) this._reapDeadTab(msg.from);
      return;
    }
    if (msg.type === 'bye') {
      // 正常关闭：与崩溃走同一回收路径（心跳租约之外的快速通道）
      if (this.isCoordinator) this._reapDeadTab(msg.from);
      return;
    }
    if (msg.type === 'lock-ctl-resync') {
      // 新协调者上任，上报自己持有/等待中的请求
      const held = [], pending = [];
      for (const rec of this.myReqs.values()) {
        const item = { reqId: rec.reqId, lock: rec.lock, mode: rec.mode, holdMs: rec.holdMs, enqueuedAt: rec.enqueuedAt };
        (rec.state === 'held' ? held : rec.state === 'pending' ? pending : []).push(item);
      }
      this._ctl('lock-ctl-report', { held, pending });
      return;
    }
    if (!msg.type || !msg.type.startsWith('lock-ctl-')) return;
    if (!this.isCoordinator) return;
    // 忽略已不在存活集合中的标签页（崩溃但消息仍在途/残留）
    if (!this._isAlive(msg.from.id)) return;

    if (msg.type === 'lock-ctl-request') {
      const st = this._lockState(msg.lock);
      st.queue.push({
        reqId: msg.reqId, lock: msg.lock, mode: msg.mode,
        holdMs: msg.holdMs, tab: msg.from, enqueuedAt: msg.enqueuedAt || msg.sentAt,
      });
      this._process(msg.lock);
    } else if (msg.type === 'lock-ctl-cancel') {
      for (const [name, st] of this.locks) {
        const i = st.queue.findIndex((q) => q.reqId === msg.reqId);
        if (i >= 0) { st.queue.splice(i, 1); this._process(name); }
      }
    } else if (msg.type === 'lock-ctl-release') {
      const st = this.locks.get(msg.lock);
      if (st && st.holders.delete(msg.reqId)) {
        this.emit('release', { reqId: msg.reqId, lock: msg.lock, tab: msg.from });
        this._process(msg.lock);
      }
    } else if (msg.type === 'lock-ctl-report') {
      // 重建状态：合并各标签页上报的持有/等待项
      for (const item of msg.held || []) {
        this._lockState(item.lock).holders.set(item.reqId, { ...item, tab: msg.from });
      }
      for (const item of msg.pending || []) {
        const st = this._lockState(item.lock);
        if (!st.queue.some((q) => q.reqId === item.reqId) && !st.holders.has(item.reqId)) {
          st.queue.push({ ...item, tab: msg.from });
        }
      }
      for (const item of [...(msg.held || []), ...(msg.pending || [])]) {
        this._lockState(item.lock).queue.sort((a, b) => a.enqueuedAt - b.enqueuedAt);
        this._process(item.lock);
      }
    }
  }

  _lockState(lock) {
    if (!this.locks.has(lock)) this.locks.set(lock, { holders: new Map(), queue: [] });
    return this.locks.get(lock);
  }

  _isAlive(tabId) {
    return tabId === this.cluster.identity.id || this.cluster.peers.has(tabId);
  }

  _elect() {
    const alive = this.cluster.aliveTabs().map((t) => t.id).sort();
    const shouldBe = alive[0] === this.cluster.identity.id;
    if (shouldBe && !this.isCoordinator) {
      this.isCoordinator = true;
      this.locks.clear();
      this.settleUntil = Date.now() + 400; // 等各页上报，避免重复授予
      this._ctl('lock-ctl-resync', {});
      setTimeout(() => { for (const name of this.locks.keys()) this._process(name); }, 450);
    } else if (!shouldBe) {
      this.isCoordinator = false;
    }
  }

  _process(lock) {
    if (Date.now() < this.settleUntil) return;
    const st = this._lockState(lock);
    // 严格 FIFO：仅当队首请求与当前持有者兼容时授予，否则停止。
    // 共享请求不会越过排队中的独占请求 —— 公平且防饿死。
    while (st.queue.length) {
      const head = st.queue[0];
      const holders = [...st.holders.values()];
      const exclusiveHeld = holders.some((h) => h.mode === 'exclusive');
      const compatible = head.mode === 'exclusive' ? holders.length === 0 : !exclusiveHeld;
      if (!compatible) break;
      st.queue.shift();
      st.holders.set(head.reqId, { ...head, grantedAt: Date.now() });
      this.emit('grant', { reqId: head.reqId, lock, mode: head.mode, tab: head.tab, holdMs: head.holdMs });
    }
  }

  _reapDeadTab(deadTab) {
    // 心跳租约过期：回收崩溃标签页持有的锁与排队请求
    let released = 0, dequeued = 0;
    for (const [name, st] of this.locks) {
      for (const [reqId, h] of [...st.holders]) {
        if (h.tab.id === deadTab.id) {
          st.holders.delete(reqId);
          released++;
          this.emit('release', { reqId, lock: name, tab: deadTab, reason: 'crash' });
        }
      }
      const before = st.queue.length;
      st.queue = st.queue.filter((q) => q.tab.id !== deadTab.id);
      dequeued += before - st.queue.length;
      this._process(name);
    }
    if (released || dequeued) {
      this.emit('crash', { tab: deadTab, released, dequeued });
    }
  }
}

function sleep(ms) { return new Promise((res) => setTimeout(res, ms)); }
