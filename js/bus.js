// 跨标签页消息总线：优先 BroadcastChannel，缺失时降级 localStorage storage 事件
export class Bus {
  constructor(channel = 'web-locks-demo') {
    this.id = crypto.randomUUID();
    this.handlers = new Set();
    if ('BroadcastChannel' in window) {
      this.bc = new BroadcastChannel(channel);
      this.bc.onmessage = (e) => this._emit(e.data);
    } else {
      this.key = `bus:${channel}`;
      window.addEventListener('storage', (e) => {
        if (e.key !== this.key || !e.newValue) return;
        try {
          const msg = JSON.parse(e.newValue);
          if (msg._src !== this.id) this._emit(msg);
        } catch { /* 忽略坏消息 */ }
      });
    }
  }
  post(msg) {
    msg._src = this.id;
    if (this.bc) this.bc.postMessage(msg);
    else localStorage.setItem(this.key, JSON.stringify({ ...msg, _t: Date.now() }));
  }
  subscribe(fn) { this.handlers.add(fn); return () => this.handlers.delete(fn); }
  _emit(msg) { for (const fn of this.handlers) fn(msg); }
}
