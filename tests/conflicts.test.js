// 冲突检测测试：循环依赖、资源互斥、过期任务、未知依赖 —— 都要定位到具体任务
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { schedule, findCycles } from '../server/engine.js';

const H = 3_600_000;
const NOW = 1_800_000_000_000;

const task = (id, over = {}) => ({
  id, name: `任务${id}`, resource: null,
  windowStart: NOW + H, windowEnd: NOW + 6 * H, durationMin: 30,
  dependsOn: [], linkIds: [], ...over,
});
const planOf = (tasks) => ({ tasks, links: [], nodes: [], services: [] });

test('循环依赖：定位到环上的具体任务', () => {
  const p = planOf([
    task('A', { dependsOn: ['C'] }),
    task('B', { dependsOn: ['A'] }),
    task('C', { dependsOn: ['B'] }),
    task('D'), // 不在环上
  ]);
  const r = schedule(p, NOW);
  assert.equal(r.ok, false);
  const e = r.errors.find(e => e.type === 'CYCLE');
  assert.deepEqual([...e.taskIds].sort(), ['A', 'B', 'C']);
  assert.ok(!e.taskIds.includes('D'));
  assert.deepEqual(findCycles(p).sort(), ['A', 'B', 'C']);
});

test('资源互斥：同一资源执行区间重叠，定位到冲突双方', () => {
  const p = planOf([
    task('A', { resource: '板卡-1', windowStart: NOW + H, durationMin: 60 }),
    task('B', { resource: '板卡-1', windowStart: NOW + H, durationMin: 60 }), // 无依赖 → 同时段
    task('C', { resource: '板卡-2', windowStart: NOW + H, durationMin: 60 }),
  ]);
  const r = schedule(p, NOW);
  assert.equal(r.ok, false);
  const e = r.errors.find(e => e.type === 'RESOURCE_CONFLICT');
  assert.deepEqual(e.taskIds.sort(), ['A', 'B']);
  assert.match(e.message, /板卡-1/);
});

test('资源互斥：有依赖串行后不冲突', () => {
  const p = planOf([
    task('A', { resource: '板卡-1', windowStart: NOW + H, durationMin: 60 }),
    task('B', { resource: '板卡-1', windowStart: NOW + H, durationMin: 60, dependsOn: ['A'] }),
  ]);
  const r = schedule(p, NOW);
  assert.equal(r.ok, true);
});

test('过期任务：窗口已结束的任务被定位', () => {
  const p = planOf([
    task('OLD', { windowStart: NOW - 2 * H, windowEnd: NOW - H }),
    task('NEW'),
  ]);
  const r = schedule(p, NOW);
  assert.equal(r.ok, false);
  const e = r.errors.find(e => e.type === 'EXPIRED_TASK');
  assert.deepEqual(e.taskIds, ['OLD']);
});

test('未知依赖：依赖不存在的任务被定位', () => {
  const p = planOf([task('A', { dependsOn: ['GHOST'] })]);
  const r = schedule(p, NOW);
  assert.equal(r.ok, false);
  const e = r.errors.find(e => e.type === 'UNKNOWN_DEPENDENCY');
  assert.deepEqual(e.taskIds, ['A']);
  assert.match(e.message, /GHOST/);
});
