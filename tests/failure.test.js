// 失败中断模拟测试：受影响链路、下游阻断、业务中断范围
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { schedule, simulateFailure } from '../server/engine.js';

const H = 3_600_000;
const NOW = 1_800_000_000_000;

// 与 seed 同构的演练场景
const plan = {
  nodes: ['gw', 'sw1', 'sw2', 'web', 'db', 'user'].map(id => ({ id })),
  links: [
    { id: 'L1', a: 'gw', b: 'sw1' }, { id: 'L2', a: 'gw', b: 'sw2' },
    { id: 'L3', a: 'sw1', b: 'web' }, { id: 'L4', a: 'sw1', b: 'db' },
    { id: 'L5', a: 'sw2', b: 'user' }, { id: 'L6', a: 'sw1', b: 'sw2' },
  ],
  services: [
    { id: 'S1', name: '办公业务', from: 'user', to: 'db' },
    { id: 'S2', name: 'Web 访问', from: 'user', to: 'web' },
  ],
  tasks: [
    { id: 'T1', name: '备份', resource: 'gw', windowStart: NOW + H, windowEnd: NOW + 5 * H, durationMin: 15, dependsOn: [], linkIds: [] },
    { id: 'T2', name: '割接L6', resource: 'sw1', windowStart: NOW + H, windowEnd: NOW + 5 * H, durationMin: 20, dependsOn: ['T1'], linkIds: ['L6'] },
    { id: 'T3', name: '割接L3', resource: 'sw1', windowStart: NOW + 2 * H, windowEnd: NOW + 6 * H, durationMin: 20, dependsOn: ['T2'], linkIds: ['L3'] },
  ],
};

test('中断模拟：受影响链路 + 替代路径 + 业务降级', () => {
  const sched = schedule(plan, NOW);
  assert.equal(sched.ok, true);
  const sim = simulateFailure(plan, sched.order, 'T2'); // L6 中断
  assert.deepEqual(sim.failedLinks.map(l => l.id), ['L6']);
  assert.deepEqual(sim.blockedTasks.map(t => t.id), ['T3']); // 下游任务被阻断
  // S1 主路径 user→sw2→sw1→db 经过 L6 → 有替代（绕行 gw）→ 降级
  const s1 = sim.services.find(s => s.serviceId === 'S1');
  assert.equal(s1.status, 'degraded');
  assert.deepEqual(s1.altPath.linkIds, ['L5', 'L2', 'L1', 'L4']);
  // S2 主路径同样过 L6 → 降级而非中断
  assert.equal(sim.services.find(s => s.serviceId === 'S2').status, 'degraded');
  assert.equal(sim.businessImpact.interrupted.length, 0);
});

test('中断模拟：无替代路径时业务中断', () => {
  const sched = schedule(plan, NOW);
  const sim = simulateFailure(plan, sched.order, 'T3'); // L3 是 web 唯一入口
  const s2 = sim.services.find(s => s.serviceId === 'S2');
  assert.equal(s2.status, 'interrupted');
  assert.equal(s2.altPath, null);
  assert.deepEqual(sim.businessImpact.interrupted.map(s => s.serviceId), ['S2']);
  // S1 不经过 L3 → 不受影响
  assert.equal(sim.services.find(s => s.serviceId === 'S1').status, 'unaffected');
});

test('中断模拟：级联影响链路包含下游任务的链路', () => {
  const sched = schedule(plan, NOW);
  const sim = simulateFailure(plan, sched.order, 'T2');
  assert.deepEqual(sim.cascadeLinks.map(l => l.id), ['L3']); // T3 受阻 → 其链路级联受影响
});
