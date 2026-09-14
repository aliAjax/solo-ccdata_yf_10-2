// 割接演练核心引擎：纯函数，无副作用，可单测。
// 时间一律用毫秒时间戳（number）。外部负责把 ISO 字符串转成时间戳后传入。

/** 稳定序列化（键排序），用于方案输入哈希 —— 并发演练一致性判定的基础 */
export function stableStringify(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(stableStringify).join(',') + ']';
  const keys = Object.keys(value).sort();
  return '{' + keys.map(k => JSON.stringify(k) + ':' + stableStringify(value[k])).join(',') + '}';
}

export async function inputHash(plan) {
  const s = stableStringify({
    tasks: plan.tasks, links: plan.links, nodes: plan.nodes, services: plan.services,
  });
  // 浏览器与 Node 都可用的摘要；Node 环境用 crypto
  const { createHash } = await import('node:crypto');
  return createHash('sha256').update(s).digest('hex').slice(0, 16);
}

const taskById = (plan) => new Map(plan.tasks.map(t => [t.id, t]));

/** 传递依赖闭包：taskId 的所有下游（依赖它的任务） */
export function transitiveDependents(plan, taskId) {
  const dependents = new Map(); // dep -> [tasks depending on dep]
  for (const t of plan.tasks) {
    for (const d of t.dependsOn || []) {
      if (!dependents.has(d)) dependents.set(d, []);
      dependents.get(d).push(t.id);
    }
  }
  const seen = new Set();
  const stack = [...(dependents.get(taskId) || [])];
  while (stack.length) {
    const cur = stack.pop();
    if (seen.has(cur)) continue;
    seen.add(cur);
    stack.push(...(dependents.get(cur) || []));
  }
  return seen;
}

/** 检测循环依赖，返回环上的具体任务 id 列表（可能多组，合并去重） */
export function findCycles(plan) {
  const ids = new Set(plan.tasks.map(t => t.id));
  const deps = new Map(plan.tasks.map(t => [t.id, (t.dependsOn || []).filter(d => ids.has(d))]));
  const state = new Map(); // 0=unvisited 1=in-stack 2=done
  const inCycle = new Set();
  const stack = [];
  const dfs = (id) => {
    state.set(id, 1);
    stack.push(id);
    for (const d of deps.get(id) || []) {
      const st = state.get(d) || 0;
      if (st === 0) dfs(d);
      else if (st === 1) {
        // 找到环：栈中从 d 到栈顶
        const idx = stack.indexOf(d);
        for (const n of stack.slice(idx)) inCycle.add(n);
      }
    }
    stack.pop();
    state.set(id, 2);
  };
  for (const id of ids) if (!state.get(id)) dfs(id);
  return [...inCycle];
}

/**
 * 依赖排序 + 窗口排程。
 * 返回 { ok, order, errors }。order: [{taskId, start, end}]，按执行顺序。
 * errors: [{type, taskIds, message}] —— 每个错误都定位到具体任务。
 */
export function schedule(plan, now) {
  const errors = [];
  const byId = taskById(plan);

  // 1. 过期任务：可用窗口已结束
  const expired = plan.tasks.filter(t => t.windowEnd <= now);
  if (expired.length) {
    errors.push({
      type: 'EXPIRED_TASK',
      taskIds: expired.map(t => t.id),
      message: `任务窗口已过期：${expired.map(t => `${t.name}（窗口截止 ${new Date(t.windowEnd).toISOString()}）`).join('、')}`,
    });
  }

  // 2. 未知依赖引用
  for (const t of plan.tasks) {
    const missing = (t.dependsOn || []).filter(d => !byId.has(d));
    if (missing.length) {
      errors.push({
        type: 'UNKNOWN_DEPENDENCY',
        taskIds: [t.id],
        message: `任务「${t.name}」依赖了不存在的任务：${missing.join('、')}`,
      });
    }
  }

  // 3. 循环依赖
  const cycle = findCycles(plan);
  if (cycle.length) {
    const names = cycle.map(id => byId.get(id)?.name || id);
    errors.push({
      type: 'CYCLE',
      taskIds: cycle,
      message: `检测到循环依赖，涉及任务：${names.join(' → ')}`,
    });
  }
  if (errors.length) return { ok: false, order: [], errors };

  // 4. Kahn 拓扑排序（确定性：同层按窗口开始时间、再按 id 排序）
  const indeg = new Map(plan.tasks.map(t => [t.id, 0]));
  const dependents = new Map(plan.tasks.map(t => [t.id, []]));
  for (const t of plan.tasks) {
    for (const d of t.dependsOn || []) {
      indeg.set(t.id, indeg.get(t.id) + 1);
      dependents.get(d).push(t.id);
    }
  }
  const ready = plan.tasks.filter(t => indeg.get(t.id) === 0)
    .sort((a, b) => a.windowStart - b.windowStart || (a.id < b.id ? -1 : 1));
  const topo = [];
  while (ready.length) {
    const t = ready.shift();
    topo.push(t);
    for (const depId of dependents.get(t.id)) {
      indeg.set(depId, indeg.get(depId) - 1);
      if (indeg.get(depId) === 0) {
        const dt = byId.get(depId);
        // 保持 ready 有序
        const i = ready.findIndex(r => r.windowStart > dt.windowStart || (r.windowStart === dt.windowStart && r.id > dt.id));
        if (i === -1) ready.push(dt); else ready.splice(i, 0, dt);
      }
    }
  }

  // 5. 最早开始排程：start = max(窗口开始, 所有前置任务结束)
  const endOf = new Map();
  const order = [];
  for (const t of topo) {
    const depEnd = Math.max(0, ...(t.dependsOn || []).map(d => endOf.get(d) ?? 0));
    const start = Math.max(t.windowStart, depEnd);
    const end = start + t.durationMin * 60_000;
    if (end > t.windowEnd) {
      errors.push({
        type: 'WINDOW_UNFEASIBLE',
        taskIds: [t.id],
        message: `任务「${t.name}」在可用窗口内排不下：最早 ${new Date(start).toISOString()} 开始，需 ${t.durationMin} 分钟，超出窗口截止 ${new Date(t.windowEnd).toISOString()}`,
      });
    }
    endOf.set(t.id, end);
    order.push({ taskId: t.id, start, end });
  }

  // 6. 资源互斥：同一资源上排程区间重叠
  const byResource = new Map();
  for (const t of plan.tasks) {
    if (!t.resource) continue;
    if (!byResource.has(t.resource)) byResource.set(t.resource, []);
    byResource.get(t.resource).push(t.id);
  }
  const posOf = new Map(order.map((o, i) => [o.taskId, i]));
  for (const [resource, ids] of byResource) {
    const slots = ids.map(id => order[posOf.get(id)]).filter(Boolean).sort((a, b) => a.start - b.start);
    for (let i = 1; i < slots.length; i++) {
      if (slots[i].start < slots[i - 1].end) {
        const a = byId.get(slots[i - 1].taskId), b = byId.get(slots[i].taskId);
        errors.push({
          type: 'RESOURCE_CONFLICT',
          taskIds: [a.id, b.id],
          message: `资源「${resource}」互斥冲突：「${a.name}」（${new Date(slots[i - 1].start).toISOString()}~${new Date(slots[i - 1].end).toISOString()}）与「${b.name}」（${new Date(slots[i].start).toISOString()}~${new Date(slots[i].end).toISOString()}）执行时间重叠`,
        });
      }
    }
  }

  return errors.length ? { ok: false, order, errors } : { ok: true, order, errors: [] };
}

// ---------- 网络路径（双向链路图上的 BFS 最短路） ----------

function buildAdj(plan, downLinkIds = new Set()) {
  const adj = new Map(plan.nodes.map(n => [n.id, []]));
  for (const l of plan.links) {
    if (downLinkIds.has(l.id)) continue;
    adj.get(l.a)?.push({ to: l.b, linkId: l.id });
    adj.get(l.b)?.push({ to: l.a, linkId: l.id });
  }
  return adj;
}

/** BFS 最短路径，返回 {nodes:[], linkIds:[]} 或 null */
export function findPath(plan, from, to, downLinkIds = new Set()) {
  const adj = buildAdj(plan, downLinkIds);
  const prev = new Map([[from, null]]);
  const queue = [from];
  while (queue.length) {
    const cur = queue.shift();
    if (cur === to) break;
    for (const e of adj.get(cur) || []) {
      if (!prev.has(e.to)) { prev.set(e.to, { node: cur, linkId: e.linkId }); queue.push(e.to); }
    }
  }
  if (!prev.has(to)) return null;
  const nodes = [], linkIds = [];
  let cur = to;
  while (cur !== null) {
    nodes.unshift(cur);
    const p = prev.get(cur);
    if (p) linkIds.unshift(p.linkId);
    cur = p ? p.node : null;
  }
  return { nodes, linkIds };
}

/**
 * 中断模拟：某一步（任务）中断。
 * 返回受影响链路、被阻断的后续任务、每条业务的受影响情况（主路径/替代路径/中断）。
 */
export function simulateFailure(plan, order, taskId) {
  const byId = taskById(plan);
  const task = byId.get(taskId);
  if (!task) throw new Error(`任务不存在: ${taskId}`);
  const failedLinkIds = new Set((task.linkIds || []).length ? task.linkIds : (task.linkId ? [task.linkId] : []));

  // 被阻断的下游任务及其链路（级联影响）
  const blocked = transitiveDependents(plan, taskId);
  const cascadeLinkIds = new Set(failedLinkIds);
  for (const tid of blocked) {
    const t = byId.get(tid);
    for (const l of (t?.linkIds?.length ? t.linkIds : (t?.linkId ? [t.linkId] : []))) cascadeLinkIds.add(l);
  }

  const services = plan.services.map(svc => {
    const primary = findPath(plan, svc.from, svc.to);
    const primaryHit = primary && primary.linkIds.some(l => failedLinkIds.has(l));
    if (!primaryHit) {
      return { serviceId: svc.id, name: svc.name, status: 'unaffected', primaryPath: primary };
    }
    const alt = findPath(plan, svc.from, svc.to, failedLinkIds);
    return alt
      ? { serviceId: svc.id, name: svc.name, status: 'degraded', primaryPath: primary, altPath: alt }
      : { serviceId: svc.id, name: svc.name, status: 'interrupted', primaryPath: primary, altPath: null };
  });

  return {
    taskId,
    taskName: task.name,
    failedLinks: plan.links.filter(l => failedLinkIds.has(l.id)).map(l => ({ ...l, reason: '直接中断' })),
    cascadeLinks: plan.links.filter(l => cascadeLinkIds.has(l.id) && !failedLinkIds.has(l.id)).map(l => ({ ...l, reason: '下游任务受阻' })),
    blockedTasks: [...blocked].map(id => ({ id, name: byId.get(id)?.name })),
    services,
    businessImpact: {
      interrupted: services.filter(s => s.status === 'interrupted'),
      degraded: services.filter(s => s.status === 'degraded'),
      unaffected: services.filter(s => s.status === 'unaffected'),
    },
  };
}

/**
 * 生成回滚顺序并校验。
 * 回滚 = 执行顺序的逆序；从 rollbackStart（通常为当前时间）起顺序回滚，
 * 每个任务的回滚区间必须落在其恢复窗口内，且满足回滚依赖（先滚下游）。
 * 返回 { ok, order, errors }；ok=false 时发布必须被拒绝。
 */
export function planRollback(plan, execOrder, rollbackStart) {
  const byId = taskById(plan);
  const errors = [];

  // 回滚依赖校验：对任意 A 依赖 B，回滚序列中 A 必须排在 B 之前
  const reversed = [...execOrder].reverse();
  const pos = new Map(reversed.map((o, i) => [o.taskId, i]));
  for (const t of plan.tasks) {
    if (!pos.has(t.id)) continue;
    for (const d of t.dependsOn || []) {
      if (pos.has(d) && pos.get(t.id) > pos.get(d)) {
        errors.push({
          type: 'ROLLBACK_DEPENDENCY',
          taskIds: [t.id, d],
          message: `回滚依赖不成立：「${t.name}」必须先于「${byId.get(d)?.name}」回滚`,
        });
      }
    }
  }

  // 恢复窗口校验：顺序回滚，每个任务在 max(上一个回滚结束, 恢复窗口开始) 开始
  const order = [];
  let cursor = rollbackStart;
  for (const o of reversed) {
    const t = byId.get(o.taskId);
    const rwStart = t.recoveryWindowStart ?? t.windowStart;
    const rwEnd = t.recoveryWindowEnd ?? t.windowEnd;
    const start = Math.max(cursor, rwStart);
    const end = start + t.durationMin * 60_000;
    if (rwEnd <= rollbackStart) {
      errors.push({
        type: 'RECOVERY_WINDOW_EXPIRED',
        taskIds: [t.id],
        message: `任务「${t.name}」的恢复窗口已过期（截止 ${new Date(rwEnd).toISOString()}），无法安全回滚`,
      });
    } else if (end > rwEnd) {
      errors.push({
        type: 'RECOVERY_WINDOW_UNFEASIBLE',
        taskIds: [t.id],
        message: `任务「${t.name}」回滚无法落入恢复窗口：最早 ${new Date(start).toISOString()} 开始，需 ${t.durationMin} 分钟，超出恢复窗口截止 ${new Date(rwEnd).toISOString()}`,
      });
    }
    order.push({ taskId: t.id, start, end });
    cursor = end;
  }

  return errors.length ? { ok: false, order, errors } : { ok: true, order, errors: [] };
}
