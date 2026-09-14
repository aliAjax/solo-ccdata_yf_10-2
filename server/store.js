// 演练存储：内存实现，关键是「同一方案并发演练只保留一致结果、步骤不重复插入」。
// 手段：drill 以 (planId, inputHash) 为幂等键；并发请求合并在飞 Promise；
// 步骤插入以 (drillId, phase, taskId) 为唯一键，重复插入返回已存在步骤。
import { randomUUID } from 'node:crypto';
import { schedule, simulateFailure, planRollback, inputHash } from './engine.js';

export function createStore(now = () => Date.now()) {
  const plans = new Map();
  const drills = new Map();   // idemKey -> drill
  const inFlight = new Map(); // idemKey -> Promise<drill>

  const savePlan = (plan) => {
    const id = plan.id || 'plan-' + randomUUID().slice(0, 8);
    const rec = { ...plan, id, createdAt: plan.createdAt || now() };
    plans.set(id, rec);
    return rec;
  };

  const getPlan = (id) => plans.get(id);
  const listPlans = () => [...plans.values()].map(p => ({ id: p.id, name: p.name, createdAt: p.createdAt, taskCount: p.tasks.length }));

  /**
   * 步骤插入（幂等）：同一 drill 内 (phase, taskId) 唯一。
   * 重复插入不新增、不报错，返回已存在的步骤 —— 保证并发/重试下不产生重复步骤。
   */
  const insertStep = (drill, step) => {
    const dup = drill.steps.find(s => s.phase === step.phase && s.taskId === step.taskId);
    if (dup) return { inserted: false, step: dup };
    const rec = { seq: drill.steps.length + 1, ...step };
    drill.steps.push(rec);
    return { inserted: true, step: rec };
  };

  /**
   * 触发演练（幂等 + 并发合并）：
   * 同一方案、同一输入哈希的并发调用共享同一次演练，返回完全一致的结果。
   */
  const runDrill = async (planId) => {
    const plan = plans.get(planId);
    if (!plan) throw Object.assign(new Error('方案不存在'), { status: 404 });
    const hash = await inputHash(plan);
    const key = `${planId}:${hash}`;

    const existing = drills.get(key);
    if (existing) return { drill: existing, reused: true };
    if (inFlight.has(key)) return { drill: await inFlight.get(key), reused: true };

    const promise = (async () => {
      const drill = {
        id: 'drill-' + randomUUID().slice(0, 8),
        key, planId, inputHash: hash,
        startedAt: now(), steps: [], simulations: [],
        schedule: null, rollback: null, status: 'running', errors: [],
      };
      const sched = schedule(plan, now());
      drill.schedule = sched;
      if (!sched.ok) {
        drill.status = 'failed';
        drill.errors = sched.errors;
        drills.set(key, drill);
        return drill;
      }
      for (const o of sched.order) {
        insertStep(drill, { phase: 'execute', taskId: o.taskId, start: o.start, end: o.end });
        drill.simulations.push(simulateFailure(plan, sched.order, o.taskId));
      }
      const rb = planRollback(plan, sched.order, now());
      drill.rollback = rb;
      if (rb.ok) {
        for (const o of rb.order) insertStep(drill, { phase: 'rollback', taskId: o.taskId, start: o.start, end: o.end });
        drill.status = 'passed';
      } else {
        drill.status = 'rollback_blocked';
        drill.errors = rb.errors;
      }
      drill.finishedAt = now();
      drills.set(key, drill);
      return drill;
    })();

    inFlight.set(key, promise);
    try {
      return { drill: await promise, reused: false };
    } finally {
      inFlight.delete(key);
    }
  };

  const getDrill = (id) => [...drills.values()].find(d => d.id === id);

  /** 发布：只有演练通过（含回滚校验）的方案才允许发布，否则拒绝并给出原因 */
  const publish = async (planId) => {
    const { drill } = await runDrill(planId);
    if (drill.status !== 'passed') {
      return {
        ok: false,
        reasons: drill.errors.length ? drill.errors : [{ type: 'DRILL_NOT_PASSED', taskIds: [], message: '演练未全部通过，禁止发布' }],
      };
    }
    const plan = plans.get(planId);
    plan.published = true;
    plan.publishedAt = now();
    return { ok: true, drillId: drill.id, publishedAt: plan.publishedAt };
  };

  return { savePlan, getPlan, listPlans, runDrill, getDrill, insertStep, publish };
}
