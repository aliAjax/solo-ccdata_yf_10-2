// 演示方案：一个带冗余链路的园区网割接场景。窗口相对当前时间生成，保证不过期。
export function seedPlan(now) {
  const m = (min) => now + min * 60_000;
  return {
    name: '核心园区网割接方案',
    nodes: [
      { id: 'gw', name: '核心路由器', type: 'router', x: 470, y: 200 },
      { id: 'sw1', name: '交换机 A', type: 'switch', x: 250, y: 350 },
      { id: 'sw2', name: '交换机 B', type: 'switch', x: 690, y: 350 },
      { id: 'web', name: 'Web 服务器', type: 'server', x: 100, y: 500 },
      { id: 'db', name: '数据库', type: 'server', x: 400, y: 530 },
      { id: 'user', name: '办公终端', type: 'device', x: 820, y: 510 },
    ],
    links: [
      { id: 'L1', a: 'gw', b: 'sw1' },
      { id: 'L2', a: 'gw', b: 'sw2' },
      { id: 'L3', a: 'sw1', b: 'web' },
      { id: 'L4', a: 'sw1', b: 'db' },
      { id: 'L5', a: 'sw2', b: 'user' },
      { id: 'L6', a: 'sw1', b: 'sw2' },
    ],
    services: [
      { id: 'S1', name: '办公业务', from: 'user', to: 'db' },
      { id: 'S2', name: 'Web 访问', from: 'user', to: 'web' },
      { id: 'S3', name: '数据库上联', from: 'db', to: 'gw' },
    ],
    tasks: [
      {
        id: 'T1', name: '配置备份', resource: 'gw',
        windowStart: m(10), windowEnd: m(70), durationMin: 15,
        dependsOn: [], linkIds: [],
        recoveryWindowStart: m(10), recoveryWindowEnd: m(240),
      },
      {
        id: 'T2', name: '割接互联链路 L6', resource: 'sw1',
        windowStart: m(30), windowEnd: m(120), durationMin: 20,
        dependsOn: ['T1'], linkIds: ['L6'],
        recoveryWindowStart: m(30), recoveryWindowEnd: m(240),
      },
      {
        id: 'T3', name: '割接服务器链路 L3', resource: 'sw1',
        windowStart: m(60), windowEnd: m(150), durationMin: 20,
        dependsOn: ['T2'], linkIds: ['L3'],
        recoveryWindowStart: m(60), recoveryWindowEnd: m(240),
      },
      {
        id: 'T4', name: '业务验证', resource: 'gw',
        windowStart: m(90), windowEnd: m(180), durationMin: 10,
        dependsOn: ['T3'], linkIds: [],
        recoveryWindowStart: m(90), recoveryWindowEnd: m(240),
      },
    ],
  };
}
