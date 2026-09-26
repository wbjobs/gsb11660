import { Bus } from './bus.js';
import { openStore, logAdd } from './idb.js';
import { NativeLockAdapter, FallbackLockAdapter } from './locks.js';
import { LockViz } from './viz.js';

const RESOURCES = ['res-alpha', 'res-beta', 'res-gamma'];
const tabId = crypto.randomUUID();
const joinedAt = Date.now();
const $ = (s) => document.querySelector(s);

const stats = { acquired: 0, timeouts: 0, cancels: 0, degraded: 0 };
const myHolds = new Map(); // reqId -> { resource, mode, since, release, degraded, timer }
const myWaits = new Map(); // reqId -> { resource, mode, since, timeout, controller }
const peers = new Map();   // tabId -> { state, lastSeen }
let kernelInfo = null;

// ---------- 日志 ----------
let store = null;
function log(msg, cls = '') {
  const li = document.createElement('li');
  if (cls) li.className = cls;
  li.textContent = `[${new Date().toLocaleTimeString()}.${String(Date.now() % 1000).padStart(3, '0')}] ${msg}`;
  const ul = $('#log');
  ul.prepend(li);
  while (ul.children.length > 200) ul.lastChild.remove();
  if (store) logAdd(store, { tab: tabId, msg, cls, ts: Date.now() }).catch(() => {});
}

// ---------- 锁引擎 ----------
const bus = new Bus();
const native = 'locks' in navigator;
const adapter = native
  ? new NativeLockAdapter()
  : new FallbackLockAdapter(bus, null, tabId, joinedAt, (m, c) => log(m, c));

$('#badge-tab').textContent = `标签页 ${tabId.slice(0, 4)}`;
$('#badge-adapter').textContent = adapter.kind;
if (!native) {
  $('#badge-coord').hidden = false;
  setInterval(() => {
    $('#badge-coord').textContent =
      `协调者 ${adapter.coordinatorId?.slice(0, 4) ?? '…'}${adapter.isCoordinator ? '（我）' : ''}`;
  }, 500);
}

// ---------- 跨标签页状态同步（驱动可视化） ----------
function myState() {
  return {
    type: 'state', tabId, joinedAt,
    holds: [...myHolds.values()].map((h) => ({
      resource: h.resource, mode: h.mode, since: h.since, degraded: h.degraded })),
    waits: [...myWaits.values()].map((w) => ({
      reqId: w.reqId, resource: w.resource, mode: w.mode, since: w.since, timeout: w.timeout })),
  };
}
let syncQueued = false;
function syncState() {
  if (syncQueued) return;
  syncQueued = true;
  queueMicrotask(() => { syncQueued = false; bus.post(myState()); });
}
bus.subscribe((m) => {
  if (m.type === 'state' && m.tabId !== tabId)
    peers.set(m.tabId, { state: m, lastSeen: Date.now() });
});
setInterval(() => {
  bus.post(myState());
  const now = Date.now();
  for (const [id, p] of peers) if (now - p.lastSeen > 6000) peers.delete(id);
}, 1000);

// ---------- 加锁编排 ----------
function releaseHold(reqId) {
  const h = myHolds.get(reqId);
  if (!h) return;
  if (h.timer) clearTimeout(h.timer);
  myHolds.delete(reqId);
  h.release();
  log(`释放 ${h.degraded ? '降级占用' : '锁'} ${h.resource}`, 'ok');
  syncState();
}

async function acquireLocks() {
  // 多资源按名称排序依次加锁 → 全局锁顺序，从根上避免死锁
  const resources = [...document.querySelectorAll('input[name=res]:checked')]
    .map((c) => c.value).sort();
  if (!resources.length) return log('请先选择至少一个资源', 'warn');
  const mode = document.querySelector('input[name=mode]:checked').value;
  const timeout = Math.max(0, +$('#timeout').value || 0);
  const holdMs = Math.max(0, +$('#hold').value || 0);
  const strategy = $('#strategy').value;
  const modeName = mode === 'shared' ? '共享' : '独占';

  for (const resource of resources) {
    const reqId = crypto.randomUUID();
    const controller = new AbortController();
    myWaits.set(reqId, { reqId, resource, mode, since: Date.now(), timeout, controller });
    log(`请求 ${modeName} 锁 ${resource}${timeout ? `（超时 ${timeout}ms）` : ''}`);
    syncState();
    try {
      const handle = await adapter.acquire(resource, mode, { timeout, signal: controller.signal });
      myWaits.delete(reqId);
      const hold = { reqId, resource, mode, since: Date.now(), degraded: false, release: handle.release };
      myHolds.set(reqId, hold);
      stats.acquired++;
      log(`获得 ${modeName} 锁 ${resource}`, 'ok');
      if (holdMs > 0) hold.timer = setTimeout(() => releaseHold(reqId), holdMs);
    } catch (err) {
      myWaits.delete(reqId);
      if (err.name === 'TimeoutError') {
        stats.timeouts++;
        if (strategy === 'degrade') {
          stats.degraded++;
          log(`等待 ${resource} 超时 → 降级为无锁执行（可能脏写！）`, 'warn');
          const hold = { reqId, resource, mode, since: Date.now(), degraded: true, release: () => {} };
          myHolds.set(reqId, hold);
          if (holdMs > 0) hold.timer = setTimeout(() => releaseHold(reqId), holdMs);
        } else {
          log(`等待 ${resource} 超时，已放弃`, 'warn');
          break; // 放弃后续资源，已持有的会在下方保持或手动释放
        }
      } else {
        stats.cancels++;
        log(`请求 ${resource} 已取消`, 'err');
        break;
      }
    } finally {
      syncState();
      renderStats();
    }
  }
}

function renderStats() {
  $('#st-acquired').textContent = stats.acquired;
  $('#st-timeout').textContent = stats.timeouts;
  $('#st-cancel').textContent = stats.cancels;
  $('#st-degraded').textContent = stats.degraded;
}

$('#btn-acquire').addEventListener('click', acquireLocks);
$('#btn-release').addEventListener('click', () => {
  for (const reqId of [...myHolds.keys()]) releaseHold(reqId);
});
$('#btn-cancel').addEventListener('click', () => {
  for (const w of myWaits.values()) w.controller.abort();
});
$('#btn-crash').addEventListener('click', () => {
  if (!confirm('将永久挂起本标签页（模拟崩溃）。\n请用浏览器任务管理器结束它，观察锁被自动回收。继续？')) return;
  document.title = '💀 已挂起（模拟崩溃）';
  log('标签页已挂起，模拟崩溃……', 'err');
  setTimeout(() => { while (true) {} }, 50);
});

// ---------- 内核状态轮询（原生模式） ----------
if (native) {
  setInterval(async () => {
    try {
      const q = await adapter.query();
      kernelInfo = { held: q.held?.length ?? 0, pending: q.pending?.length ?? 0 };
    } catch { kernelInfo = null; }
  }, 1000);
}

// ---------- 可视化 ----------
const viz = new LockViz($('#viz'));
function buildModel() {
  const lanes = RESOURCES.map((name) => ({ name, holders: [], queue: [] }));
  const laneOf = (r) => lanes.find((l) => l.name === r);
  const feed = (id, st) => {
    for (const h of st.holds) laneOf(h.resource)?.holders.push({ tab: id, ...h });
    for (const w of st.waits) laneOf(w.resource)?.queue.push({ tab: id, ...w });
  };
  feed(tabId, myState());
  for (const [id, p] of peers) feed(id, p.state);
  for (const l of lanes) l.queue.sort((a, b) => a.since - b.since); // FIFO 展示
  const tabs = [
    { id: tabId, self: true, holds: myHolds.size, waits: myWaits.size },
    ...[...peers.entries()].map(([id, p]) => ({
      id, self: false, holds: p.state.holds.length, waits: p.state.waits.length })),
  ];
  return { tabs, lanes, kernel: kernelInfo, now: Date.now() };
}
setInterval(() => viz.setModel(buildModel()), 250);
viz.setModel(buildModel());
viz.start();

// ---------- 启动 ----------
openStore().then((db) => {
  store = db;
  if (!native) adapter.store = db;
}).catch(() => log('IndexedDB 不可用，事件将不落盘', 'warn'));
log(`标签页上线，锁引擎：${adapter.kind}`);
renderStats();
