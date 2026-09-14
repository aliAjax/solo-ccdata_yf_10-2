// 替代路径测试：冗余拓扑下的 BFS 重路由
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { findPath } from '../server/engine.js';

// 拓扑：user--sw2--gw--sw1--web，另有 sw1--sw2 冗余互联
const plan = {
  nodes: ['gw', 'sw1', 'sw2', 'web', 'user'].map(id => ({ id })),
  links: [
    { id: 'L1', a: 'gw', b: 'sw1' },
    { id: 'L2', a: 'gw', b: 'sw2' },
    { id: 'L3', a: 'sw1', b: 'web' },
    { id: 'L5', a: 'sw2', b: 'user' },
    { id: 'L6', a: 'sw1', b: 'sw2' },
  ],
  tasks: [], services: [],
};

test('无故障时走最短路径', () => {
  const p = findPath(plan, 'user', 'web');
  assert.deepEqual(p.linkIds, ['L5', 'L6', 'L3']); // user→sw2→sw1→web
});

test('链路中断后找到替代路径', () => {
  const p = findPath(plan, 'user', 'web', new Set(['L6']));
  assert.deepEqual(p.linkIds, ['L5', 'L2', 'L1', 'L3']); // 绕行核心路由器
});

test('无替代路径时返回 null', () => {
  const p = findPath(plan, 'user', 'web', new Set(['L3'])); // web 唯一入口断了
  assert.equal(p, null);
});
