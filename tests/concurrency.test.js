// 并发演练测试：同一方案并发触发，只保留一致结果，步骤不重复插入
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createStore } from '../server/store.js';
import { createServer } from '../server/index.js';
import { seedPlan } from '../server/seed.js';

const NOW = 1_800_000_000_000;

const withServer = async (fn) => {
  const store = createStore(() => NOW);
  const plan = store.savePlan(seedPlan(NOW + 3_600_000)); // 窗口在未来
  const server = createServer(store);
  await new Promise(r => server.listen(0, r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try { await fn(base, plan, store); } finally { server.close(); }
};

test('并发演练：20 个并发请求得到同一演练结果，步骤无重复', async () => {
  await withServer(async (base, plan) => {
    const results = await Promise.all(
      Array.from({ length: 20 }, () =>
        fetch(`${base}/api/plans/${plan.id}/drill`, { method: 'POST' }).then(r => r.json()))
    );
    const ids = new Set(results.map(r => r.drill.id));
    assert.equal(ids.size, 1); // 只保留一个一致结果
    const drill = results[0].drill;
    assert.equal(drill.status, 'passed');
    // 步骤数 = 执行步数 + 回滚步数，且无重复 (phase, taskId)
    const keys = drill.steps.map(s => `${s.phase}:${s.taskId}`);
    assert.equal(new Set(keys).size, keys.length);
    assert.equal(drill.steps.filter(s => s.phase === 'execute').length, plan.tasks.length);
    assert.equal(drill.steps.filter(s => s.phase === 'rollback').length, plan.tasks.length);
    // 所有并发响应的完整内容一致
    for (const r of results) assert.deepEqual(r.drill, drill);
  });
});

test('重复触发：已完成的演练直接复用，不重新插入步骤', async () => {
  await withServer(async (base, plan) => {
    const r1 = await fetch(`${base}/api/plans/${plan.id}/drill`, { method: 'POST' }).then(r => r.json());
    const r2 = await fetch(`${base}/api/plans/${plan.id}/drill`, { method: 'POST' }).then(r => r.json());
    assert.equal(r2.reused, true);
    assert.equal(r1.drill.id, r2.drill.id);
    assert.equal(r2.drill.steps.length, r1.drill.steps.length);
  });
});

test('步骤插入幂等：同 (phase, taskId) 重复插入被去重', async () => {
  const store = createStore(() => NOW);
  const drill = { steps: [] };
  const s1 = store.insertStep(drill, { phase: 'execute', taskId: 'T1' });
  const s2 = store.insertStep(drill, { phase: 'execute', taskId: 'T1' });
  const s3 = store.insertStep(drill, { phase: 'rollback', taskId: 'T1' }); // 不同阶段允许
  assert.equal(s1.inserted, true);
  assert.equal(s2.inserted, false);
  assert.equal(s3.inserted, true);
  assert.equal(drill.steps.length, 2);
  assert.equal(s2.step.seq, s1.step.seq); // 返回已存在的步骤
});
