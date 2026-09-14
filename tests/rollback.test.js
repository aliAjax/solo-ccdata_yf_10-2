// 回滚测试：回滚顺序、恢复窗口不成立时拒绝发布、回滚依赖校验
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { schedule, planRollback } from '../server/engine.js';
import { createStore } from '../server/store.js';

const H = 3_600_000, M = 60_000;
const NOW = 1_800_000_000_000;

const task = (id, deps = [], over = {}) => ({
  id, name: `任务${id}`, resource: null,
  windowStart: NOW + H, windowEnd: NOW + 4 * H, durationMin: 30,
  dependsOn: deps, linkIds: [],
  recoveryWindowStart: NOW + H, recoveryWindowEnd: NOW + 6 * H,
  ...over,
});
const planOf = (tasks) => ({ tasks, links: [], nodes: [], services: [] });

test('回滚顺序为执行顺序的逆序，且全部落在恢复窗口内', () => {
  const plan = planOf([task('A'), task('B', ['A']), task('C', ['B'])]);
  const sched = schedule(plan, NOW);
  const rb = planRollback(plan, sched.order, NOW);
  assert.equal(rb.ok, true);
  assert.deepEqual(rb.order.map(o => o.taskId), ['C', 'B', 'A']);
  for (const o of rb.order) assert.ok(o.end <= NOW + 6 * H);
});

test('恢复窗口不成立：回滚排不进窗口，定位到具体任务', () => {
  const plan = planOf([
    task('A', [], { durationMin: 60 }),
    task('B', ['A'], { durationMin: 60 }),
    // C 最后执行、最先回滚没问题；A 最后回滚时恢复窗口已不够
    task('C', ['B'], { durationMin: 60 }),
  ]);
  // 把 A 的恢复窗口卡得很紧：回滚序列 C(60)+B(60)+A(60)，A 的窗口装不下
  plan.tasks[0].recoveryWindowEnd = NOW + 90 * M;
  const sched = schedule(plan, NOW);
  const rb = planRollback(plan, sched.order, NOW);
  assert.equal(rb.ok, false);
  const e = rb.errors.find(e => e.type === 'RECOVERY_WINDOW_UNFEASIBLE');
  assert.deepEqual(e.taskIds, ['A']);
});

test('恢复窗口已过期：拒绝发布并说明原因', async () => {
  const store = createStore(() => NOW);
  const plan = store.savePlan(planOf([
    task('A', [], { recoveryWindowEnd: NOW - M }), // 恢复窗口已过
  ]));
  const result = await store.publish(plan.id);
  assert.equal(result.ok, false);
  const e = result.reasons.find(r => r.type === 'RECOVERY_WINDOW_EXPIRED');
  assert.deepEqual(e.taskIds, ['A']);
  assert.match(e.message, /恢复窗口已过期/);
});

test('回滚依赖不成立：下游未先回滚时报错', () => {
  const plan = planOf([task('A'), task('B', ['A'])]);
  // 合法：执行顺序 A→B，回滚自动为 B→A，无回滚依赖错误
  const good = planRollback(plan, [{ taskId: 'A', start: 0, end: 1 }, { taskId: 'B', start: 1, end: 2 }], NOW);
  assert.equal(good.errors.filter(e => e.type === 'ROLLBACK_DEPENDENCY').length, 0);
  // 非法：执行顺序违反拓扑（B 先于 A），回滚序列中 A 排在 B 前面 → 回滚依赖不成立
  const bad = planRollback(plan, [{ taskId: 'B', start: 0, end: 1 }, { taskId: 'A', start: 1, end: 2 }], NOW);
  const v = bad.errors.filter(e => e.type === 'ROLLBACK_DEPENDENCY');
  assert.equal(v.length, 1);
  assert.deepEqual(v[0].taskIds, ['B', 'A']);
});

test('演练全部通过才允许发布', async () => {
  const okStore = createStore(() => NOW);
  const okPlan = okStore.savePlan(planOf([task('A'), task('B', ['A'])]));
  const okRes = await okStore.publish(okPlan.id);
  assert.equal(okRes.ok, true);
  assert.ok(okRes.drillId);

  const badStore = createStore(() => NOW);
  const badPlan = badStore.savePlan(planOf([
    task('A', ['B']), task('B', ['A']), // 循环依赖 → 演练失败
  ]));
  const badRes = await badStore.publish(badPlan.id);
  assert.equal(badRes.ok, false);
  assert.ok(badRes.reasons.some(r => r.type === 'CYCLE'));
});
