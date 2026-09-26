// app.js — 主应用：后端选择、事件总线、状态跟踪、UI  wiring、场景演练。

import { Cluster } from './cluster.js';
import { WebLocksBackend } from './backend-weblocks.js';
import { BroadcastLockBackend } from './backend-broadcast.js';
import { EventStore } from './store.js';
import { Viz } from './viz.js';

const LOCK_NAMES = ['resource-A', 'resource-B'];

// ---------- 基础设施 ----------

const cluster = new Cluster();
const store = new EventStore();
await store.init();

// 后端选择：支持 Web Locks 则优先使用，否则（或用户强制）降级到 BroadcastChannel 模拟
const forceFallback = localStorage.getItem('locks-demo-force-fallback') === '1';
const webLocksSupported = 'locks' in navigator;
const useFallback = forceFallback || !webLocksSupported;

// 事实事件出口：后端产生的事件经 BroadcastChannel 广播给所有标签页（含本页回环）
function emit(event, payload) {
  cluster.send('lock-event', { event, ...payload });
}

const backend = useFallback
  ? new BroadcastLockBackend(cluster, emit)
  : new WebLocksBackend(cluster, emit);

// ---------- 可视化状态（由事件流推导） ----------

const vizLocks = {};
for (const name of LOCK_NAMES) vizLocks[name] = { holders: [], queue: [], degraded: [] };

function lockState(name) {
  if (!vizLocks[name]) vizLocks[name] = { holders: [], queue: [], degraded: [] };
  return vizLocks[name];
}

function applyLockEvent(ev) {
  const st = ev.lock ? lockState(ev.lock) : null;
  switch (ev.event) {
    case 'request':
      st.queue.push({ reqId: ev.reqId, mode: ev.mode, tab: ev.tab, since: Date.now() });
      break;
    case 'grant': {
      st.queue = st.queue.filter((q) => q.reqId !== ev.reqId);
      st.holders.push({ reqId: ev.reqId, mode: ev.mode, tab: ev.tab, since: Date.now(), holdMs: ev.holdMs || 0 });
      break;
    }
    case 'release':
      st.holders = st.holders.filter((h) => h.reqId !== ev.reqId);
      break;
    case 'timeout':
    case 'cancel':
      st.queue = st.queue.filter((q) => q.reqId !== ev.reqId);
      break;
    case 'degraded-start':
      st.degraded.push({ reqId: ev.reqId, tab: ev.tab, since: Date.now() });
      break;
    case 'degraded-end':
      st.degraded = st.degraded.filter((d) => d.reqId !== ev.reqId);
      break;
  }
}

function reapTabFromViz(tabId) {
  for (const st of Object.values(vizLocks)) {
    st.holders = st.holders.filter((h) => h.tab.id !== tabId);
    st.queue = st.queue.filter((q) => q.tab.id !== tabId);
    st.degraded = st.degraded.filter((d) => d.tab.id !== tabId);
  }
}

// ---------- 事件日志 ----------

const logEl = document.getElementById('event-log');

const EVENT_TEXT = {
  request: (e) => `请求 ${e.lock}（${e.mode}），超时 ${e.timeoutMs}ms`,
  grant: (e) => `获得 ${e.lock}（${e.mode}）`,
  release: (e) => `释放 ${e.lock}${e.reason === 'crash' ? '（崩溃自动回收）' : ''}${e.heldMs ? `，持有 ${(e.heldMs / 1000).toFixed(1)}s` : ''}`,
  timeout: (e) => `等待 ${e.lock} 超时（${e.timeoutMs}ms）→ 降级`,
  cancel: (e) => `取消对 ${e.lock} 的等待`,
  'degraded-start': (e) => `⚠ 降级执行临界区（无锁保护）`,
  'degraded-end': (e) => `降级执行结束`,
  crash: (e) => `💥 检测到标签页崩溃，回收 ${e.released} 把锁、${e.dequeued} 个排队请求`,
  error: (e) => `错误：${e.message}`,
  bye: (e) => `标签页正常关闭，其锁已被释放`,
};

function renderLogItem(ev) {
  const li = document.createElement('li');
  const d = new Date(ev.ts);
  const ts = `${d.toLocaleTimeString('zh-CN', { hour12: false })}.${String(d.getMilliseconds()).padStart(3, '0')}`;
  const tab = ev.detail.tab;
  const text = EVENT_TEXT[ev.type]
    ? EVENT_TEXT[ev.type](ev.detail)
    : (ev.detail.text || JSON.stringify(ev.detail));
  li.innerHTML = `<span class="ts">${ts}</span>` +
    (tab ? `<span class="tab" style="color:${tab.color}">${tab.name}</span>` : `<span class="tab">·</span>`) +
    `<span class="type-${ev.type}">${text}</span>`;
  return li;
}

function logEvent(type, detail, { persist = true } = {}) {
  const ev = { ts: Date.now(), type, detail };
  logEl.prepend(renderLogItem(ev));
  while (logEl.children.length > 200) logEl.lastChild.remove();
  if (persist) store.log(type, detail);
}

// ---------- 消息入口 ----------

cluster.onMessage((msg) => {
  if (msg.type === 'lock-event') {
    applyLockEvent(msg);
    logEvent(msg.event, msg);
    refreshHandlesTable();
  } else if (msg.type === 'peer-crashed') {
    // 安全网：无论哪种后端，崩溃标签页的残留都从可视化中清除。
    // Web Locks 后端下浏览器已真正释放锁；降级后端下协调者也会广播 release 事实。
    reapTabFromViz(msg.from.id);
    logEvent('crash', { tab: msg.from, released: 0, dequeued: 0 }, { persist: false });
  } else if (msg.type === 'bye') {
    reapTabFromViz(msg.from.id);
    logEvent('bye', { tab: msg.from }, { persist: false });
  }
});

// ---------- 活动句柄表 ----------

const handles = new Map(); // reqId -> handle
const handlesTbody = document.querySelector('#handles-table tbody');

function trackHandle(handle) {
  handles.set(handle.reqId, handle);
  refreshHandlesTable();
  handle.done.finally(() => {
    setTimeout(() => { handles.delete(handle.reqId); refreshHandlesTable(); }, 1500);
    refreshHandlesTable();
  });
}

const STATE_TEXT = {
  pending: '等待中', held: '持有中', released: '已释放',
  cancelled: '已取消', degraded: '已降级', error: '错误',
};

function refreshHandlesTable() {
  handlesTbody.innerHTML = '';
  for (const h of handles.values()) {
    const tr = document.createElement('tr');
    const canCancel = h.state === 'pending';
    const canRelease = h.state === 'held';
    tr.innerHTML = `<td>${h.reqId.slice(-6)}</td><td>${h.lock}</td><td>${h.mode}</td>` +
      `<td>${STATE_TEXT[h.state] || h.state}</td><td></td>`;
    const td = tr.lastChild;
    if (canRelease) {
      const btn = document.createElement('button');
      btn.className = 'small';
      btn.textContent = '释放';
      btn.onclick = () => { h.release(); refreshHandlesTable(); };
      td.appendChild(btn);
    }
    if (canCancel) {
      const btn = document.createElement('button');
      btn.className = 'small warn';
      btn.textContent = '取消';
      btn.onclick = () => { h.cancel(); refreshHandlesTable(); };
      td.appendChild(btn);
    }
    handlesTbody.appendChild(tr);
  }
}
setInterval(refreshHandlesTable, 500);

// ---------- 控制面板 ----------

const $ = (id) => document.getElementById(id);

function acquireFromUI(manual) {
  const handle = backend.acquire({
    lock: $('lock-name').value,
    mode: $('lock-mode').value,
    holdMs: manual ? 0 : Number($('hold-ms').value),
    timeoutMs: Number($('timeout-ms').value),
  });
  trackHandle(handle);
  return handle;
}

$('btn-acquire').onclick = () => acquireFromUI(false);
$('btn-acquire-manual').onclick = () => acquireFromUI(true);
$('btn-release-all').onclick = () => { for (const h of handles.values()) h.release(); refreshHandlesTable(); };
$('btn-cancel-all').onclick = () => { for (const h of handles.values()) h.cancel(); refreshHandlesTable(); };
$('btn-clear-log').onclick = async () => { await store.clear(); logEl.innerHTML = ''; };

const fallbackToggle = $('force-fallback');
fallbackToggle.checked = forceFallback;
fallbackToggle.onchange = () => {
  localStorage.setItem('locks-demo-force-fallback', fallbackToggle.checked ? '1' : '0');
  location.reload();
};

// ---------- 场景演练 ----------

function sleep(ms) { return new Promise((res) => setTimeout(res, ms)); }

// 死锁避免：多锁获取统一按全局锁序（名称排序）进行，消除循环等待。
// safe=false 时按调用方给定顺序获取，用于演示死锁及超时兜底。
async function runMultiLock(locksInOrder, { mode = 'exclusive', holdMs = 3000, timeoutMs = 6000, safe = true } = {}) {
  const order = safe ? [...locksInOrder].sort() : [...locksInOrder];
  if (safe && order.join() !== locksInOrder.join()) {
    logEvent('deadlock', { tab: cluster.identity, text: `锁序规范化 ${locksInOrder.join('→')} ⇒ ${order.join('→')}（全局锁序，避免循环等待）` });
  }
  const acquiredHandles = [];
  try {
    for (const lock of order) {
      const h = backend.acquire({ lock, mode, holdMs: 0, timeoutMs });
      trackHandle(h);
      acquiredHandles.push(h);
      const status = await h.acquired;
      if (status !== 'held') throw new Error(status);
    }
    logEvent('info', { tab: cluster.identity, text: `进入复合临界区 ${order.join(' + ')}，持有 ${holdMs}ms` });
    await sleep(holdMs);
  } catch (err) {
    logEvent('info', { tab: cluster.identity, text: `复合临界区中止（${err.message}），已按逆序释放已获得的锁` });
  } finally {
    for (const h of [...acquiredHandles].reverse()) h.release();
  }
}

const SCENARIOS = {
  'exclusive-race': () => {
    for (let i = 0; i < 3; i++) {
      trackHandle(backend.acquire({ lock: 'resource-A', mode: 'exclusive', holdMs: 3000, timeoutMs: 15000 }));
    }
  },
  'shared-parallel': () => {
    for (let i = 0; i < 3; i++) {
      trackHandle(backend.acquire({ lock: 'resource-A', mode: 'shared', holdMs: 4000, timeoutMs: 10000 }));
    }
  },
  'shared-vs-exclusive': async () => {
    trackHandle(backend.acquire({ lock: 'resource-A', mode: 'shared', holdMs: 6000, timeoutMs: 15000 }));
    trackHandle(backend.acquire({ lock: 'resource-A', mode: 'shared', holdMs: 6000, timeoutMs: 15000 }));
    await sleep(300);
    trackHandle(backend.acquire({ lock: 'resource-A', mode: 'exclusive', holdMs: 3000, timeoutMs: 15000 }));
  },
  'timeout-degrade': async () => {
    trackHandle(backend.acquire({ lock: 'resource-A', mode: 'exclusive', holdMs: 15000, timeoutMs: 30000 }));
    await sleep(500);
    trackHandle(backend.acquire({ lock: 'resource-A', mode: 'exclusive', holdMs: 3000, timeoutMs: 3000 }));
  },
  'deadlock-safe': () => {
    runMultiLock(['resource-A', 'resource-B'], { safe: true });
    runMultiLock(['resource-B', 'resource-A'], { safe: true });
  },
  'deadlock-unsafe': () => {
    logEvent('info', { tab: cluster.identity, text: '无序获取 A→B 与 B→A：将发生循环等待，由超时机制兜底降级' });
    runMultiLock(['resource-A', 'resource-B'], { safe: false, timeoutMs: 4000 });
    runMultiLock(['resource-B', 'resource-A'], { safe: false, timeoutMs: 4000 });
  },
  'long-hold': () => {
    trackHandle(backend.acquire({ lock: 'resource-A', mode: 'exclusive', holdMs: 30000, timeoutMs: 60000 }));
  },
};

document.querySelectorAll('[data-scenario]').forEach((btn) => {
  btn.onclick = () => SCENARIOS[btn.dataset.scenario]();
});

// ---------- 顶部状态 ----------

$('tab-badge').textContent = `本标签页：${cluster.identity.name}`;
$('tab-badge').style.borderColor = cluster.identity.color;
$('tab-badge').style.color = cluster.identity.color;

const backendBadge = $('backend-badge');
backendBadge.textContent = webLocksSupported
  ? (useFallback ? '后端：BroadcastChannel 模拟（手动降级）' : '后端：Web Locks API')
  : '后端：BroadcastChannel 模拟（浏览器不支持 Web Locks）';
backendBadge.classList.add(useFallback ? 'fallback' : 'ok');

// ---------- 启动可视化 ----------

const viz = new Viz($('viz'), () => ({
  tabs: cluster.aliveTabs(),
  meId: cluster.identity.id,
  backendName: backend.name,
  locks: vizLocks,
}));
viz.start();

// ---------- 恢复历史日志 ----------

for (const ev of await store.recent(80)) {
  logEl.appendChild(renderLogItem(ev));
}

logEvent('info', {
  tab: cluster.identity,
  text: `页面启动，后端=${backend.name}，Web Locks ${webLocksSupported ? '可用' : '不可用'}`,
});
