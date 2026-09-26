// backend-weblocks.js — 基于 navigator.locks 的锁后端。
// 语义保证：
//  - FIFO 公平性：Web Locks 规范保证同一锁按请求顺序授予；
//  - 崩溃释放：标签页关闭/崩溃时浏览器自动释放其持有的锁；
//  - 超时：AbortSignal 中止等待，随后进入"降级执行"（无锁保护跑临界区）；
//  - 取消：同一个 AbortController 支持用户主动取消排队中的请求。

let reqSeq = 0;

export class WebLocksBackend {
  constructor(cluster, emit) {
    this.cluster = cluster;
    this.emit = emit; // (type, payload) => void，事实事件（日志 + 可视化）
    this.name = 'Web Locks API';
  }

  acquire({ lock, mode = 'exclusive', holdMs = 4000, timeoutMs = 5000 }) {
    const reqId = `W${Date.now().toString(36)}-${++reqSeq}`;
    const tab = this.cluster.identity;
    const ac = new AbortController();
    let abortReason = null; // 'timeout' | 'cancel'
    let state = 'pending';

    let resolveAcquired, resolveDone;
    const acquired = new Promise((res) => (resolveAcquired = res));
    const done = new Promise((res) => (resolveDone = res));

    const handle = {
      reqId, lock, mode,
      acquired, done,
      get state() { return state; },
      release: () => releaseFn && releaseFn('manual'),
      cancel: () => {
        if (state !== 'pending') return;
        abortReason = 'cancel';
        ac.abort();
      },
    };

    let releaseFn = null;
    const released = new Promise((res) => (releaseFn = res));

    const timeoutTimer = timeoutMs > 0
      ? setTimeout(() => { abortReason = 'timeout'; ac.abort(); }, timeoutMs)
      : null;

    this.emit('request', { reqId, lock, mode, tab, holdMs, timeoutMs });

    navigator.locks.request(lock, { mode, signal: ac.signal }, async () => {
      // —— 进入临界区（已获锁）——
      if (timeoutTimer) clearTimeout(timeoutTimer);
      state = 'held';
      const grantedAt = Date.now();
      this.emit('grant', { reqId, lock, mode, tab, holdMs });
      resolveAcquired('held');
      if (holdMs > 0) {
        setTimeout(() => releaseFn('auto-timeout-hold'), holdMs);
      }
      await released; // 锁一直持有，直到 release() 被调用或持有时长到期
      this.emit('release', { reqId, lock, mode, tab, heldMs: Date.now() - grantedAt });
    }).then(() => {
      state = 'released';
      resolveDone('released');
    }).catch(async (err) => {
      if (timeoutTimer) clearTimeout(timeoutTimer);
      if (err && err.name === 'AbortError' && state === 'pending') {
        if (abortReason === 'cancel') {
          state = 'cancelled';
          this.emit('cancel', { reqId, lock, mode, tab });
          resolveAcquired('cancelled');
          resolveDone('cancelled');
          return;
        }
        // —— 超时降级：放弃等锁，无保护地执行临界区 ——
        state = 'degraded';
        this.emit('timeout', { reqId, lock, mode, tab, timeoutMs });
        this.emit('degraded-start', { reqId, lock, mode, tab, holdMs });
        resolveAcquired('degraded');
        await sleep(holdMs > 0 ? holdMs : 2000);
        this.emit('degraded-end', { reqId, lock, mode, tab });
        resolveDone('degraded');
        return;
      }
      state = 'error';
      this.emit('error', { reqId, lock, mode, tab, message: String(err) });
      resolveAcquired('error');
      resolveDone('error');
    });

    return handle;
  }
}

function sleep(ms) { return new Promise((res) => setTimeout(res, ms)); }
