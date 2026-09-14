import React, { useEffect, useMemo, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { api } from './api.js';
import './styles.css';

const toLocalInput = (ts) => { const d = new Date(ts); d.setMinutes(d.getMinutes() - d.getTimezoneOffset()); return d.toISOString().slice(0, 16); };
const fromLocalInput = (s) => new Date(s).getTime();
const fmt = (ts) => new Date(ts).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });

const ERR_LABEL = {
  CYCLE: '循环依赖', EXPIRED_TASK: '任务过期', RESOURCE_CONFLICT: '资源互斥',
  WINDOW_UNFEASIBLE: '窗口不可行', UNKNOWN_DEPENDENCY: '未知依赖',
  RECOVERY_WINDOW_EXPIRED: '恢复窗口过期', RECOVERY_WINDOW_UNFEASIBLE: '恢复窗口不可行',
  ROLLBACK_DEPENDENCY: '回滚依赖不成立', DRILL_NOT_PASSED: '演练未通过',
};

function TopoView({ plan, sim }) {
  const nodeById = useMemo(() => new Map(plan.nodes.map(n => [n.id, n])), [plan]);
  const linkState = useMemo(() => {
    const m = new Map();
    if (!sim) return m;
    for (const l of sim.failedLinks) m.set(l.id, 'failed');
    for (const l of sim.cascadeLinks) if (!m.has(l.id)) m.set(l.id, 'cascade');
    for (const s of sim.services) if (s.altPath) for (const lid of s.altPath.linkIds) if (!m.has(lid)) m.set(lid, 'alt');
    return m;
  }, [sim]);
  return (
    <svg className="topo" viewBox="0 0 920 620" data-testid="topo">
      {plan.links.map(l => {
        const a = nodeById.get(l.a), b = nodeById.get(l.b);
        if (!a || !b) return null;
        const st = linkState.get(l.id) || 'normal';
        return (
          <g key={l.id}>
            <line x1={a.x} y1={a.y} x2={b.x} y2={b.y} className={`link ${st}`} />
            <text x={(a.x + b.x) / 2} y={(a.y + b.y) / 2 - 6} className={`link-label ${st}`}>{l.id}</text>
          </g>
        );
      })}
      {plan.nodes.map(n => (
        <g key={n.id} className={`tnode ${n.type}`}>
          <circle cx={n.x} cy={n.y} r="26" />
          <text x={n.x} y={n.y + 4} className="tnode-icon">{n.type === 'router' ? '◉' : n.type === 'switch' ? '▦' : n.type === 'server' ? '▣' : '▱'}</text>
          <text x={n.x} y={n.y + 44} className="tnode-name">{n.name}</text>
        </g>
      ))}
      <g className="topo-legend">
        <line x1="20" y1="590" x2="50" y2="590" className="link failed" /><text x="56" y="594">中断链路</text>
        <line x1="140" y1="590" x2="170" y2="590" className="link cascade" /><text x="176" y="594">级联影响</text>
        <line x1="260" y1="590" x2="290" y2="590" className="link alt" /><text x="296" y="594">替代路径</text>
      </g>
    </svg>
  );
}

function TaskEditor({ plan, setPlan, selTask, setSelTask, highlight }) {
  const task = plan.tasks.find(t => t.id === selTask);
  const update = (id, patch) => setPlan({ ...plan, tasks: plan.tasks.map(t => t.id === id ? { ...t, ...patch } : t) });
  const addTask = () => {
    const id = 'T' + (Math.max(0, ...plan.tasks.map(t => parseInt(t.id.slice(1)) || 0)) + 1);
    const now = Date.now();
    setPlan({
      ...plan,
      tasks: [...plan.tasks, {
        id, name: `新任务 ${id}`, resource: '', durationMin: 30,
        windowStart: now + 3600e3, windowEnd: now + 3 * 3600e3,
        dependsOn: [], linkIds: [],
        recoveryWindowStart: now + 3600e3, recoveryWindowEnd: now + 6 * 3600e3,
      }],
    });
    setSelTask(id);
  };
  const removeTask = (id) => {
    setPlan({
      ...plan,
      tasks: plan.tasks.filter(t => t.id !== id).map(t => ({ ...t, dependsOn: (t.dependsOn || []).filter(d => d !== id) })),
    });
    setSelTask(null);
  };
  return (
    <aside className="panel tasks-panel">
      <div className="panel-title"><span>维护任务</span><button onClick={addTask} data-testid="add-task">＋ 添加</button></div>
      <div className="task-list">
        {plan.tasks.map(t => (
          <button key={t.id} data-testid={`task-item-${t.id}`}
            className={`task-item ${selTask === t.id ? 'sel' : ''} ${highlight.includes(t.id) ? 'flagged' : ''}`}
            onClick={() => setSelTask(t.id)}>
            <strong>{t.name}</strong>
            <small>{t.id} · {t.resource || '无资源'} · {t.durationMin}min</small>
          </button>
        ))}
      </div>
      {task && (
        <div className="task-editor" data-testid="task-editor">
          <label>名称<input value={task.name} onChange={e => update(task.id, { name: e.target.value })} /></label>
          <label>互斥资源<input value={task.resource || ''} placeholder="如 sw1 / 板卡-1" onChange={e => update(task.id, { resource: e.target.value })} /></label>
          <label>时长（分钟）<input type="number" min="1" value={task.durationMin} onChange={e => update(task.id, { durationMin: +e.target.value })} /></label>
          <label>窗口开始<input type="datetime-local" value={toLocalInput(task.windowStart)} onChange={e => update(task.id, { windowStart: fromLocalInput(e.target.value) })} /></label>
          <label>窗口截止<input type="datetime-local" value={toLocalInput(task.windowEnd)} onChange={e => update(task.id, { windowEnd: fromLocalInput(e.target.value) })} /></label>
          <label>恢复窗口开始<input type="datetime-local" value={toLocalInput(task.recoveryWindowStart)} onChange={e => update(task.id, { recoveryWindowStart: fromLocalInput(e.target.value) })} /></label>
          <label>恢复窗口截止<input type="datetime-local" value={toLocalInput(task.recoveryWindowEnd)} onChange={e => update(task.id, { recoveryWindowEnd: fromLocalInput(e.target.value) })} /></label>
          <div className="check-group"><span>依赖任务</span>
            {plan.tasks.filter(t => t.id !== task.id).map(t => (
              <label key={t.id} className="check">
                <input type="checkbox" checked={(task.dependsOn || []).includes(t.id)}
                  onChange={e => update(task.id, { dependsOn: e.target.checked ? [...(task.dependsOn || []), t.id] : (task.dependsOn || []).filter(d => d !== t.id) })} />
                {t.name}
              </label>
            ))}
          </div>
          <div className="check-group"><span>影响链路</span>
            {plan.links.map(l => (
              <label key={l.id} className="check">
                <input type="checkbox" checked={(task.linkIds || []).includes(l.id)}
                  onChange={e => update(task.id, { linkIds: e.target.checked ? [...(task.linkIds || []), l.id] : (task.linkIds || []).filter(x => x !== l.id) })} />
                {l.id}（{l.a}↔{l.b}）
              </label>
            ))}
          </div>
          <button className="danger" onClick={() => removeTask(task.id)}>删除任务</button>
        </div>
      )}
    </aside>
  );
}

function ErrorsPanel({ errors, onLocate }) {
  if (!errors?.length) return null;
  return (
    <div className="errors" data-testid="errors-panel">
      <div className="panel-title"><span>发现 {errors.length} 个问题（点击定位任务）</span></div>
      {errors.map((e, i) => (
        <button key={i} className="error-item" data-testid={`error-${e.type}`} onClick={() => onLocate(e.taskIds)}>
          <b>{ERR_LABEL[e.type] || e.type}</b>
          <span>{e.message}</span>
          <small>涉及：{e.taskIds.join('、')}</small>
        </button>
      ))}
    </div>
  );
}

function App() {
  const [plan, setPlanRaw] = useState(null);
  const [dirty, setDirty] = useState(false);
  const [sched, setSched] = useState(null);
  const [drill, setDrill] = useState(null);
  const [sim, setSim] = useState(null);
  const [simTask, setSimTask] = useState(null);
  const [pub, setPub] = useState(null);
  const [selTask, setSelTask] = useState(null);
  const [highlight, setHighlight] = useState([]);
  const [notice, setNotice] = useState('');

  useEffect(() => {
    api.listPlans().then(list => api.getPlan(list[0].id)).then(p => { setPlanRaw(p); setSelTask(p.tasks[0]?.id); });
  }, []);

  const setPlan = (p) => { setPlanRaw(p); setDirty(true); };
  const saveIfDirty = async () => {
    if (!dirty) return;
    await api.savePlan(plan);
    setDirty(false);
  };
  const reset = () => { setSched(null); setDrill(null); setSim(null); setSimTask(null); setPub(null); };

  const runSchedule = async () => {
    await saveIfDirty(); reset();
    const r = await api.schedule(plan.id);
    setSched(r);
    setNotice(r.ok ? `排程成功：${r.order.length} 步` : `排程失败：${r.errors.length} 个问题`);
  };
  const runDrill = async () => {
    await saveIfDirty(); reset();
    const r = await api.drill(plan.id);
    setSched(r.drill.schedule);
    setDrill(r.drill);
    setNotice(r.drill.status === 'passed' ? '演练全部通过，可以发布' : `演练未通过：${r.drill.status}`);
  };
  const runSim = async (taskId) => {
    await saveIfDirty();
    const r = await api.simulate(plan.id, taskId);
    setSim(r); setSimTask(taskId);
  };
  const doPublish = async () => {
    await saveIfDirty();
    try {
      const r = await api.publish(plan.id);
      setPub(r);
      setNotice('发布成功');
    } catch (e) {
      setPub(e.data || { ok: false, reasons: [{ type: 'DRILL_NOT_PASSED', taskIds: [], message: e.message }] });
      setNotice('发布被拒绝');
    }
  };

  if (!plan) return <div className="loading">加载中…</div>;
  const taskById = new Map(plan.tasks.map(t => [t.id, t]));
  const nodeName = (id) => plan.nodes.find(n => n.id === id)?.name || id;
  const pathText = (p) => p ? p.nodes.map(nodeName).join(' → ') : '无';

  return (
    <div className="app">
      <header>
        <div className="brand"><span className="brand-mark">⇄</span><div><strong>网络割接演练台</strong><small>CUTOVER DRILL STUDIO</small></div></div>
        <div className="file"><span className={`dot ${drill?.status === 'passed' ? 'ok' : ''}`}></span>
          <div><strong>{plan.name}{dirty && <em className="dirty">（未保存）</em>}</strong>
            <small>{plan.tasks.length} 个任务 · {plan.links.length} 条链路{plan.published ? ' · 已发布' : ''}</small></div>
        </div>
        <div className="top-actions">
          <button onClick={() => api.savePlan(plan).then(() => { setDirty(false); setNotice('方案已保存'); })}>保存方案</button>
          <button onClick={runSchedule} data-testid="btn-schedule">① 依赖排程</button>
          <button onClick={runDrill} data-testid="btn-drill">② 完整演练</button>
          <button className="save" onClick={doPublish} data-testid="btn-publish">③ 发布</button>
        </div>
      </header>

      <div className="layout">
        <TaskEditor plan={plan} setPlan={(p) => { setPlan(p); reset(); }} selTask={selTask} setSelTask={setSelTask} highlight={highlight} />

        <main className="center">
          <TopoView plan={plan} sim={sim} />
          <ErrorsPanel errors={[...(sched?.errors || []), ...(drill?.errors || [])]} onLocate={(ids) => { setHighlight(ids); setSelTask(ids[0]); setTimeout(() => setHighlight([]), 2500); }} />

          {sched?.ok && (
            <div className="panel" data-testid="exec-order">
              <div className="panel-title"><span>执行顺序（点击任一步模拟中断）</span>
                {drill && <b className={`badge ${drill.status}`}>{drill.status === 'passed' ? '演练通过' : drill.status === 'failed' ? '排程失败' : '回滚受阻'}</b>}
              </div>
              {sched.order.map((o, i) => {
                const t = taskById.get(o.taskId);
                return (
                  <div key={o.taskId} className={`step ${simTask === o.taskId ? 'simming' : ''}`} data-testid={`step-${o.taskId}`}>
                    <span className="seq">{i + 1}</span>
                    <div className="step-info"><strong>{t?.name}</strong>
                      <small>{fmt(o.start)} ~ {fmt(o.end)} · 资源 {t?.resource || '—'} · 依赖 {(t?.dependsOn || []).join('、') || '无'}</small></div>
                    <button onClick={() => runSim(o.taskId)} data-testid={`simulate-${o.taskId}`}>⚠ 模拟中断</button>
                  </div>
                );
              })}
            </div>
          )}

          {drill?.rollback && (
            <div className="panel" data-testid="rollback-order">
              <div className="panel-title"><span>回滚顺序（执行的逆序，须落入恢复窗口）</span>
                <b className={`badge ${drill.rollback.ok ? 'passed' : 'failed'}`}>{drill.rollback.ok ? '回滚可行' : '回滚不成立'}</b></div>
              {drill.rollback.order.map((o, i) => (
                <div key={o.taskId} className="step rollback">
                  <span className="seq">R{i + 1}</span>
                  <div className="step-info"><strong>{taskById.get(o.taskId)?.name}</strong>
                    <small>{fmt(o.start)} ~ {fmt(o.end)}</small></div>
                </div>
              ))}
            </div>
          )}
        </main>

        <aside className="panel right-panel">
          {sim && (
            <div data-testid="sim-result">
              <div className="panel-title"><span>中断模拟：{sim.taskName}</span></div>
              <div className="sim-section"><b>受影响链路</b>
                {[...sim.failedLinks, ...sim.cascadeLinks].map(l => (
                  <div key={l.id} className={`link-row ${l.reason === '直接中断' ? 'failed' : 'cascade'}`}>
                    <span>{l.id}（{nodeName(l.a)} ↔ {nodeName(l.b)}）</span><small>{l.reason}</small>
                  </div>
                ))}
                {!sim.failedLinks.length && !sim.cascadeLinks.length && <small className="muted">该步骤不直接影响链路</small>}
              </div>
              {sim.blockedTasks.length > 0 && (
                <div className="sim-section"><b>下游受阻任务</b>
                  {sim.blockedTasks.map(t => <div key={t.id} className="link-row cascade"><span>{t.name}</span><small>{t.id}</small></div>)}
                </div>
              )}
              <div className="sim-section" data-testid="business-impact"><b>业务中断范围</b>
                {sim.services.map(s => (
                  <div key={s.serviceId} className={`svc ${s.status}`}>
                    <div className="svc-head"><strong>{s.name}</strong>
                      <b className={`badge ${s.status}`}>{s.status === 'interrupted' ? '中断' : s.status === 'degraded' ? '降级（走替代路径）' : '不受影响'}</b></div>
                    <small>主路径：{pathText(s.primaryPath)}</small>
                    {s.altPath && <small>替代路径：{pathText(s.altPath)}</small>}
                    {s.status === 'interrupted' && <small className="nopath">无替代路径可用</small>}
                  </div>
                ))}
                <div className="impact-summary">
                  中断 {sim.businessImpact.interrupted.length} · 降级 {sim.businessImpact.degraded.length} · 正常 {sim.businessImpact.unaffected.length}
                </div>
              </div>
            </div>
          )}
          {pub && (
            <div className={`publish-result ${pub.ok ? 'ok' : 'refused'}`} data-testid="publish-result">
              <div className="panel-title"><span>{pub.ok ? '✓ 发布成功' : '× 发布被拒绝'}</span></div>
              {pub.ok
                ? <small>演练 {pub.drillId} 全部通过，方案已发布。</small>
                : (pub.reasons || []).map((r, i) => (
                  <div key={i} className="error-item static">
                    <b>{ERR_LABEL[r.type] || r.type}</b><span>{r.message}</span>
                    {r.taskIds?.length > 0 && <small>涉及：{r.taskIds.join('、')}</small>}
                  </div>
                ))}
            </div>
          )}
          {!sim && !pub && <div className="placeholder">先执行「依赖排程」，再点击任一步「模拟中断」，最后「完整演练」并发布。</div>}
        </aside>
      </div>
      {notice && <div className="toast" onClick={() => setNotice('')}>{notice}</div>}
    </div>
  );
}

createRoot(document.getElementById('root')).render(<App />);
