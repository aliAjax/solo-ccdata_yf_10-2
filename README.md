# 网络割接演练台（Cutover Drill Studio）

录入维护任务、依赖与可用窗口，按依赖自动排出执行顺序；对循环依赖、窗口重叠、资源互斥、过期任务定位到具体任务；任选一步模拟中断，展示受影响链路、替代路径与业务中断范围；全部通过后生成回滚顺序，回滚依赖或恢复窗口不成立时拒绝发布并说明原因。同一方案的并发演练只保留一致结果，步骤不会重复插入。

## 运行

```bash
npm install
npm run build      # 构建前端到 dist/
npm run server     # 启动 http://localhost:4173（API + 静态托管）
```

开发模式：`npm run server` + `npm run dev`（Vite 代理 /api 到 4173）。

## 验证

```bash
npm test           # 23 个测试：依赖排序 / 冲突 / 替代路径 / 失败中断 / 并发演练 / 回滚失败
npm run verify     # 真实浏览器（Playwright + Chromium）端到端验证，截图存 e2e/shots/
```

`npm run verify` 自包含：脚本自行启动隔离服务（全新内存存储、每次从初始演示方案开始），
结束后自动清理，不依赖任何手动启动的常驻服务，可连续重复执行且结果一致。

## 中文字体

应用随包提供裁剪后的 Noto Sans SC（`public/fonts/`，Regular + Bold 各约 4.5MB woff2，
覆盖全部 CJK 常用字与界面符号），通过 `@font-face` 加载，无需系统字体即可正常显示中文。

## 结构

```
server/engine.js   核心引擎（纯函数）：拓扑排序、冲突检测、BFS 路径、中断模拟、回滚规划
server/store.js    演练存储：幂等键 (planId, inputHash) + 在飞请求合并 + 步骤唯一约束
server/index.js    HTTP API（零依赖 node:http）
server/seed.js     演示方案（带冗余链路的园区网）
src/main.jsx       React 演练台界面
tests/             node:test 六类测试
e2e/               Playwright 浏览器验证
```

## 关键设计

- **冲突定位**：每类问题（`CYCLE` / `EXPIRED_TASK` / `RESOURCE_CONFLICT` / `WINDOW_UNFEASIBLE` / `UNKNOWN_DEPENDENCY` / `RECOVERY_WINDOW_*` / `ROLLBACK_DEPENDENCY`）都携带具体 `taskIds`，前端点击错误即高亮对应任务。
- **中断模拟**：任务关联链路；中断后级联阻断下游任务；对每条业务比较主路径是否经过故障链路，BFS 重算替代路径，无替代路径则判定业务中断。
- **回滚**：执行顺序的逆序；逐任务校验回滚依赖（下游先滚）与恢复窗口（回滚区间必须落入窗口），任一不成立即拒绝发布并列出原因。
- **并发幂等**：演练以方案输入哈希为幂等键，并发请求共享同一次演练结果；步骤按 `(phase, taskId)` 唯一，重复插入返回已存在步骤，不产生重复。
