// 依赖排序测试
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { schedule } from '../server/engine.js';

const H = 3_600_000, M = 60_000;
const NOW = 1_800_000_000_000; // 固定“当前时间”，保证测试可重复

const task = (id, deps = [], over = {}) => ({
  id, name: id, resource: null,
  windowStart: NOW + H, windowEnd: NOW + 6 * H, durationMin: 30,
  dependsOn: deps, linkIds: [], ...over,
});

test('依赖排序：拓扑序正确，前置任务先执行', () => {
  const plan = { tasks: [task('C', ['B']), task('A'), task('B', ['A'])], links: [], nodes: [], services: [] };
  const r = schedule(plan, NOW);
  assert.equal(r.ok, true);
  assert.deepEqual(r.order.map(o => o.taskId), ['A', 'B', 'C']);
});

test('依赖排序：执行时间不早于前置任务结束时间', () => {
  const plan = {
    tasks: [
      task('A', [], { windowStart: NOW + H, durationMin: 60 }),
      task('B', ['A'], { windowStart: NOW + H, durationMin: 30 }), // 窗口虽同时开，但必须等 A 结束
    ],
    links: [], nodes: [], services: [],
  };
  const r = schedule(plan, NOW);
  assert.equal(r.ok, true);
  const [a, b] = r.order;
  assert.equal(b.start, a.end); // B 紧贴 A 之后
});

test('依赖排序：同层任务按窗口开始时间确定性地排序', () => {
  const mk = () => [
    task('Z', [], { windowStart: NOW + 3 * H }),
    task('Y', [], { windowStart: NOW + H }),
    task('X', [], { windowStart: NOW + 2 * H }),
  ];
  const p1 = { tasks: mk(), links: [], nodes: [], services: [] };
  const p2 = { tasks: mk().reverse(), links: [], nodes: [], services: [] };
  const r1 = schedule(p1, NOW), r2 = schedule(p2, NOW);
  assert.deepEqual(r1.order.map(o => o.taskId), ['Y', 'X', 'Z']);
  assert.deepEqual(r1.order, r2.order); // 与输入顺序无关，结果一致
});

test('窗口不可行：依赖把任务推出窗口，定位到具体任务', () => {
  const plan = {
    tasks: [
      task('A', [], { windowStart: NOW + H, durationMin: 120 }),
      task('B', ['A'], { windowStart: NOW + H, windowEnd: NOW + 2 * H, durationMin: 45 }),
    ],
    links: [], nodes: [], services: [],
  };
  const r = schedule(plan, NOW);
  assert.equal(r.ok, false);
  const e = r.errors.find(e => e.type === 'WINDOW_UNFEASIBLE');
  assert.deepEqual(e.taskIds, ['B']);
  assert.match(e.message, /B/);
});
