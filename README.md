# Web Locks 多标签页锁竞争演示

纯静态页面，无构建步骤。技术栈：Web Locks API + BroadcastChannel + IndexedDB + Canvas（ES Modules）。

## 运行

```bash
python3 -m http.server 8000
# 打开 http://localhost:8000 ，并多开几个相同标签页
```

## 架构

- `js/locks.js` — 锁引擎，两个可互换适配器：
  - `NativeLockAdapter`：原生 `navigator.locks`，支持 exclusive/shared、AbortSignal 超时与取消；标签页崩溃/关闭由浏览器自动释放锁。
  - `FallbackLockAdapter`：浏览器不支持时降级。按 `(joinedAt, tabId)` 选举存活协调者，协调者维护 FIFO 等待队列并授权；持有者靠心跳租约（4s）续命，崩溃即被回收；锁状态快照持久化到 IndexedDB，协调者崩溃后新协调者可恢复。
- `js/bus.js` — BroadcastChannel 消息总线（BC 也缺失时降级 localStorage storage 事件）。
- `js/idb.js` — IndexedDB：心跳、锁状态快照、事件审计日志。
- `js/viz.js` — Canvas 实时渲染：在线标签页、各资源持有者、FIFO 等待队列、超时倒计时条、内核 `locks.query()` 交叉确认。
- `js/app.js` — 编排：多资源按名称排序加锁（全局锁顺序 → 死锁避免）、超时降级策略、状态广播。

## 验收标准 ↔ 验证方法

| 标准 | 操作 |
|---|---|
| 多标签页竞争无死锁 | 多标签页同时勾选多个资源点「获取锁」；全局锁顺序保证不死锁 |
| 共享/独占语义正确 | 两个标签页同时求 shared → 同时持有；一 shared 一 exclusive → 互斥 |
| 锁超时能降级 | 超时策略选「降级」，A 长占用，B 超时后以黄色「降级」块执行 |
| 等待队列公平 | 多标签页排队，Canvas 队列左→右即 FIFO 授权顺序 |
| 崩溃后锁自动释放 | A 持锁后点「模拟崩溃」并用浏览器任务管理器杀掉，B 的等待随即被授权（原生由浏览器保证；降级模式 4s 租约过期回收） |
| 不支持时降级 | DevTools 控制台 `delete navigator.locks` 需刷新前注入，或用不支持浏览器打开，徽标显示「BroadcastChannel 模拟」 |
| 可视化实时准确 | 原生模式下底部有 `locks.query()` 内核计数交叉确认 |
| 主线程不卡 | 全程异步 + rAF 渲染，无忙等（「模拟崩溃」按钮除外，那是故意的） |

## 说明

- 「模拟崩溃」会死循环挂起标签页，请用浏览器任务管理器（Chrome: Shift+Esc）结束它。
- 事件日志同时写入 IndexedDB `web-locks-demo` 库的 `log` 表，便于事后审计。
