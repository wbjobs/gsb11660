// cluster.js — 标签页身份、BroadcastChannel 消息总线、心跳与存活探测。
// 两种锁后端与可视化都基于它感知"哪些标签页还活着"。

const CHANNEL = 'web-locks-demo-v1';
const HEARTBEAT_MS = 500;
const PEER_TTL_MS = 1600; // 超过该时长未收到心跳即判定标签页崩溃/关闭

const PALETTE = ['#e05c5c', '#4f8cff', '#3fbf7f', '#c586e0', '#e0a03c', '#4fc3d9', '#d96a9b', '#8fce5a'];

function shortId(id) { return id.slice(0, 4).toUpperCase(); }

function makeIdentity() {
  // sessionStorage 保证刷新后身份延续，且每个标签页互不相同
  let id = sessionStorage.getItem('locks-demo-tab-id');
  if (!id) {
    id = crypto.randomUUID();
    sessionStorage.setItem('locks-demo-tab-id', id);
  }
  let hash = 0;
  for (const ch of id) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0;
  return {
    id,
    name: 'Tab-' + shortId(id),
    color: PALETTE[hash % PALETTE.length],
    startedAt: Date.now(),
  };
}

export class Cluster {
  constructor() {
    this.identity = makeIdentity();
    this.peers = new Map(); // tabId -> {id,name,color,lastSeen}
    this.listeners = new Set();
    this.peerListeners = new Set();
    this.channel = new BroadcastChannel(CHANNEL);
    this.channel.onmessage = (e) => this._onMessage(e.data);
    this._heartbeatTimer = setInterval(() => this._heartbeat(), HEARTBEAT_MS);
    this._sweepTimer = setInterval(() => this._sweep(), HEARTBEAT_MS);
    window.addEventListener('beforeunload', () => {
      this._post({ type: 'bye' }); // 正常关闭：尽力通知，崩溃则靠心跳超时
    });
    this._heartbeat(); // 立即宣布自己的存在
  }

  onMessage(fn) { this.listeners.add(fn); }
  onPeerChange(fn) { this.peerListeners.add(fn); }

  send(type, data = {}) { this._post({ type, ...data }); }

  aliveTabs() {
    return [this.identity, ...this.peers.values()];
  }

  _post(msg) {
    msg.from = { id: this.identity.id, name: this.identity.name, color: this.identity.color };
    msg.sentAt = Date.now();
    this.channel.postMessage(msg);
    this._dispatch(msg, true); // BroadcastChannel 不回投给自己，本地补发
  }

  _onMessage(msg) {
    if (!msg || !msg.from || msg.from.id === this.identity.id) return;
    this._dispatch(msg, false);
  }

  _dispatch(msg, isLocal) {
    if (msg.type === 'heartbeat' || msg.type === 'hello') {
      const isNew = !this.peers.has(msg.from.id);
      this.peers.set(msg.from.id, { ...msg.from, lastSeen: Date.now() });
      if (isNew && !isLocal) this._emitPeerChange();
      if (msg.type === 'hello' && !isLocal) this._heartbeat(); // 新成员上线，回个心跳让它尽快看到我
      return;
    }
    if (msg.type === 'bye') {
      if (this.peers.delete(msg.from.id)) this._emitPeerChange();
    }
    for (const fn of this.listeners) fn(msg, isLocal);
  }

  _heartbeat() {
    this._post({ type: 'heartbeat' });
  }

  _sweep() {
    const now = Date.now();
    let changed = false;
    for (const [id, peer] of this.peers) {
      if (now - peer.lastSeen > PEER_TTL_MS) {
        this.peers.delete(id);
        changed = true;
        for (const fn of this.listeners) {
          fn({ type: 'peer-crashed', from: peer, sentAt: now }, false);
        }
      }
    }
    if (changed) this._emitPeerChange();
  }

  _emitPeerChange() {
    for (const fn of this.peerListeners) fn(this.aliveTabs());
  }
}
