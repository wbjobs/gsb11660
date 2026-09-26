// Canvas 实时可视化：标签页面板 + 每个资源的持有者/等待队列
export function colorFor(tabId) {
  let h = 0;
  for (const ch of tabId) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return `hsl(${h % 360} 70% 55%)`;
}

const fmt = (ms) => ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`;

export class LockViz {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.model = { tabs: [], lanes: [], kernel: null, now: Date.now() };
  }
  setModel(m) { this.model = m; }
  start() {
    const loop = () => { this.render(); requestAnimationFrame(loop); };
    requestAnimationFrame(loop);
  }

  render() {
    const { tabs, lanes, kernel } = this.model;
    const now = Date.now();
    const dpr = window.devicePixelRatio || 1;
    const W = this.canvas.clientWidth || 600;
    const laneH = 96;
    const H = 92 + lanes.length * laneH + (kernel ? 34 : 0) + 12;
    if (this.canvas.width !== W * dpr || this.canvas.height !== H * dpr) {
      this.canvas.width = W * dpr;
      this.canvas.height = H * dpr;
      this.canvas.style.height = `${H}px`;
    }
    const ctx = this.ctx;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);
    ctx.font = '12px monospace';

    // ---- 标签页面板 ----
    ctx.fillStyle = '#8fa3c8';
    ctx.fillText('在线标签页', 14, 22);
    let x = 14;
    for (const t of tabs) {
      const w = 128;
      ctx.fillStyle = t.self ? '#1d3a6b' : '#1b2440';
      ctx.strokeStyle = colorFor(t.id);
      ctx.beginPath(); ctx.roundRect(x, 32, w, 40, 8); ctx.fill(); ctx.stroke();
      ctx.fillStyle = colorFor(t.id);
      ctx.beginPath(); ctx.arc(x + 14, 46, 5, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = '#dbe4f0';
      ctx.fillText(`${t.id.slice(0, 4)}${t.self ? ' (我)' : ''}`, x + 26, 50);
      ctx.fillStyle = '#8fa3c8';
      ctx.fillText(`持${t.holds} 等${t.waits}`, x + 26, 66);
      x += w + 10;
    }

    // ---- 资源泳道 ----
    let y = 92;
    for (const lane of lanes) {
      ctx.fillStyle = '#101828';
      ctx.strokeStyle = '#2c3a5e';
      ctx.beginPath(); ctx.roundRect(10, y, W - 20, laneH - 10, 10); ctx.fill(); ctx.stroke();
      ctx.fillStyle = '#c8d6f0';
      ctx.font = 'bold 13px monospace';
      ctx.fillText(lane.name, 22, y + 20);
      ctx.font = '12px monospace';

      // 持有者
      ctx.fillStyle = '#8fa3c8';
      ctx.fillText('持有者', 22, y + 40);
      let hx = 22;
      const hy = y + 46;
      if (!lane.holders.length) {
        ctx.fillStyle = '#3a4a6e';
        ctx.fillText('（空闲）', hx, hy + 16);
      }
      for (const h of lane.holders) {
        const w = 150;
        ctx.fillStyle = h.degraded ? '#4a3418' : colorFor(h.tab);
        ctx.beginPath(); ctx.roundRect(hx, hy, w, 26, 6); ctx.fill();
        ctx.fillStyle = '#0b0f18';
        ctx.font = 'bold 12px monospace';
        const tag = h.degraded ? '降级' : (h.mode === 'shared' ? '共享' : '独占');
        ctx.fillText(`${tag} ${h.tab.slice(0, 4)} ${fmt(now - h.since)}`, hx + 8, hy + 17);
        ctx.font = '12px monospace';
        hx += w + 8;
      }

      // 等待队列（FIFO，左→右即先来后到）
      const qy = y + 78;
      ctx.fillStyle = '#8fa3c8';
      ctx.fillText(`等待队列 (${lane.queue.length})`, 190, y + 40);
      let qx = 190;
      for (const wq of lane.queue) {
        const w = 150;
        ctx.strokeStyle = colorFor(wq.tab);
        ctx.setLineDash([4, 3]);
        ctx.beginPath(); ctx.roundRect(qx, qy - 14, w, 22, 6); ctx.stroke();
        ctx.setLineDash([]);
        ctx.fillStyle = '#c8d6f0';
        const tag = wq.mode === 'shared' ? '共享' : '独占';
        ctx.fillText(`${tag} ${wq.tab.slice(0, 4)} 等${fmt(now - wq.since)}`, qx + 8, qy + 1);
        if (wq.timeout > 0) { // 超时倒计时条
          const left = Math.max(0, wq.timeout - (now - wq.since));
          ctx.fillStyle = left > 0 ? '#e8b23f' : '#c0392b';
          ctx.fillRect(qx, qy + 8, (w * left) / wq.timeout, 3);
        }
        qx += w + 8;
      }
      y += laneH;
    }

    // ---- 内核真实状态（navigator.locks.query）----
    if (kernel) {
      ctx.fillStyle = '#6b7fa6';
      ctx.fillText(
        `内核确认（locks.query）：持有 ${kernel.held} 个 · 排队 ${kernel.pending} 个`,
        14, y + 16);
    }
  }
}
