// API 客户端
const req = async (url, method = 'GET', body) => {
  const res = await fetch(url, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json();
  if (!res.ok) throw Object.assign(new Error(data.error || '请求失败'), { status: res.status, data });
  return data;
};

export const api = {
  listPlans: () => req('/api/plans'),
  getPlan: (id) => req(`/api/plans/${id}`),
  savePlan: (plan) => req(`/api/plans/${plan.id}`, 'PUT', plan),
  schedule: (id) => req(`/api/plans/${id}/schedule`, 'POST'),
  simulate: (id, taskId) => req(`/api/plans/${id}/simulate`, 'POST', { taskId }),
  drill: (id) => req(`/api/plans/${id}/drill`, 'POST'),
  publish: (id) => req(`/api/plans/${id}/publish`, 'POST'),
};
