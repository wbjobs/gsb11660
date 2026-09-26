// viz.js — Canvas 实时可视化：标签页存活状态、每把锁的持有者、FIFO 等待队列、降级执行。
// 全部绘制在 requestAnimationFrame 中，数据来自外部状态快照，主线程无阻塞计算。

export class Viz {
  constructor(canvas, getState) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.getState = getState;
    this._running = false;
  }

  start() {
    this._running = true;
    const loop = () => {
      if (!this._running) return;
      this._draw();
      requestAnimationFrame(loop);
    };
    requestAnimationFrame(loop);
  }

  stop() { this._running = false; }

  _draw() {
    const { canvas, ctx } = this;
    const dpr = window.devicePixelRatio || 1;
    const w = canvas.clientWidth, h = canvas.clientHeight;
    if (canvas.width !== w * dpr || canvas.height !== h * dpr) {
      canvas.width = w * dpr;
      canvas.height = h * dpr;
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);

    const state = this.getState();
    const now = performance.now();
    const pulse = 0.82 + 0.18 * Math.sin(now / 280);

    this._drawTabs(ctx, state, w);

    const names = Object.keys(state.locks).sort();
    if (!names.length) return;
    const cardW = Math.min(460, (w - 16 * (names.length + 1)) / names.length);
    names.forEach((name, i) => {
      this._drawLock(ctx, 16 + i * (cardW + 16), 64, cardW, h - 80, name, state.locks[name], pulse);
    });
  }

  _drawTabs(ctx, state, w) {
    ctx.font = '12px sans-serif';
    ctx.textBaseline = 'middle';
    let x = 16;
    const y = 26;
    ctx.fillStyle = '#8a97b5';
    ctx.fillText(`后端：${state.backendName}    存活标签页：`, x, y);
    x += ctx.measureText(`后端：${state.backendName}    存活标签页：`).width + 8;
    for (const tab of state.tabs) {
      const label = tab.name + (tab.id === state.meId ? '（我）' : '');
      const tw = ctx.measureText(label).width;
      // 心跳呼吸点
      ctx.beginPath();
      ctx.arc(x + 5, y, 4, 0, Math.PI * 2);
      ctx.fillStyle = tab.color;
      ctx.globalAlpha = 0.6 + 0.4 * Math.sin(performance.now() / 250 + x);
      ctx.fill();
      ctx.globalAlpha = 1;
      ctx.fillStyle = tab.id === state.meId ? '#ffffff' : '#aab6cf';
      ctx.fillText(label, x + 14, y);
      x += tw + 28;
      if (x > w - 120) break;
    }
  }

  _drawLock(ctx, x, y, w, h, name, lock, pulse) {
    // 卡片
    roundRect(ctx, x, y, w, h, 10);
    ctx.fillStyle = '#171e2e';
    ctx.fill();
    ctx.strokeStyle = '#2a3550';
    ctx.stroke();

    ctx.font = 'bold 13px sans-serif';
    ctx.fillStyle = '#4f8cff';
    ctx.textBaseline = 'alphabetic';
    ctx.fillText(`🔒 ${name}`, x + 14, y + 24);

    // —— 临界区 ——
    const csY = y + 36;
    const csH = 110;
    roundRect(ctx, x + 10, csY, w - 20, csH, 8);
    ctx.fillStyle = '#10182b';
    ctx.fill();
    ctx.setLineDash([5, 4]);
    ctx.strokeStyle = '#3a4a70';
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.font = '11px sans-serif';
    ctx.fillStyle = '#8a97b5';
    ctx.fillText('临界区', x + 18, csY + 16);

    let cx = x + 18, cy = csY + 26;
    for (const holder of lock.holders) {
      this._drawHolderChip(ctx, cx, cy, holder, pulse);
      cx += 164;
      if (cx + 160 > x + w - 14) { cx = x + 18; cy += 58; }
    }
    for (const deg of lock.degraded) {
      this._drawDegradedChip(ctx, cx, cy, deg);
      cx += 164;
      if (cx + 160 > x + w - 14) { cx = x + 18; cy += 58; }
    }
    if (!lock.holders.length && !lock.degraded.length) {
      ctx.fillStyle = '#33405e';
      ctx.font = '12px sans-serif';
      ctx.fillText('（空闲）', x + 18, cy + 26);
    }

    // —— 等待队列（FIFO）——
    const qY = csY + csH + 14;
    ctx.font = '11px sans-serif';
    ctx.fillStyle = '#8a97b5';
    ctx.fillText(`等待队列（FIFO，共 ${lock.queue.length} 个）`, x + 14, qY + 10);
    let qx = x + 14, qy = qY + 18;
    lock.queue.forEach((req, i) => {
      this._drawQueueChip(ctx, qx, qy, req, i + 1);
      qx += 128;
      if (qx + 124 > x + w - 10) { qx = x + 14; qy += 44; }
    });
  }

  _drawHolderChip(ctx, x, y, holder, pulse) {
    const w = 156, h = 46;
    ctx.save();
    ctx.globalAlpha = pulse;
    roundRect(ctx, x, y, w, h, 7);
    ctx.fillStyle = holder.tab.color;
    ctx.fill();
    ctx.restore();
    ctx.font = 'bold 12px sans-serif';
    ctx.fillStyle = '#0f1420';
    ctx.textBaseline = 'alphabetic';
    const modeTag = holder.mode === 'exclusive' ? 'X 独占' : 'S 共享';
    ctx.fillText(`${holder.tab.name} · ${modeTag}`, x + 10, y + 19);
    // 持有进度条
    if (holder.holdMs > 0) {
      const p = Math.min(1, (Date.now() - holder.since) / holder.holdMs);
      roundRect(ctx, x + 10, y + h - 13, w - 20, 5, 2.5);
      ctx.fillStyle = 'rgba(15,20,32,.35)';
      ctx.fill();
      roundRect(ctx, x + 10, y + h - 13, (w - 20) * (1 - p), 5, 2.5);
      ctx.fillStyle = '#0f1420';
      ctx.fill();
    } else {
      ctx.font = '10px sans-serif';
      ctx.fillText('手动释放', x + 10, y + h - 8);
    }
  }

  _drawDegradedChip(ctx, x, y, deg) {
    const w = 156, h = 46;
    roundRect(ctx, x, y, w, h, 7);
    ctx.save();
    ctx.clip();
    ctx.fillStyle = '#7a5a1c';
    ctx.fillRect(x, y, w, h);
    ctx.strokeStyle = '#e0a03c';
    ctx.lineWidth = 4;
    for (let i = -h; i < w + h; i += 12) {
      ctx.beginPath();
      ctx.moveTo(x + i, y + h);
      ctx.lineTo(x + i + h, y);
      ctx.stroke();
    }
    ctx.restore();
    ctx.font = 'bold 12px sans-serif';
    ctx.fillStyle = '#fff';
    ctx.fillText(`${deg.tab.name} · 降级`, x + 10, y + 19);
    ctx.font = '10px sans-serif';
    ctx.fillText('⚠ 无锁保护执行中', x + 10, y + h - 9);
  }

  _drawQueueChip(ctx, x, y, req, pos) {
    const w = 120, h = 34;
    roundRect(ctx, x, y, w, h, 6);
    ctx.fillStyle = '#1c2a4a';
    ctx.fill();
    ctx.strokeStyle = req.tab.color;
    ctx.stroke();
    ctx.font = 'bold 11px sans-serif';
    ctx.fillStyle = '#4f8cff';
    ctx.textBaseline = 'alphabetic';
    ctx.fillText(`#${pos}`, x + 7, y + 14);
    ctx.fillStyle = '#dbe4f5';
    const modeTag = req.mode === 'exclusive' ? 'X' : 'S';
    ctx.fillText(`${req.tab.name} ${modeTag}`, x + 26, y + 14);
    ctx.font = '10px sans-serif';
    ctx.fillStyle = '#8a97b5';
    const wait = ((Date.now() - req.since) / 1000).toFixed(1);
    ctx.fillText(`等待 ${wait}s`, x + 26, y + 27);
  }
}

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}
