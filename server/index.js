// HTTP 服务：API + 静态托管前端构建产物。零依赖（node:http）。
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createStore } from './store.js';
import { schedule, simulateFailure, planRollback } from './engine.js';
import { seedPlan } from './seed.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DIST = path.join(__dirname, '..', 'dist');

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml' };

export function createServer(store = createStore()) {
  if (!store.listPlans().length) store.savePlan(seedPlan(Date.now()));

  const json = (res, code, body) => {
    res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(body));
  };
  const readBody = (req) => new Promise((resolve, reject) => {
    let data = '';
    req.on('data', c => { data += c; if (data.length > 1e6) req.destroy(); });
    req.on('end', () => { try { resolve(data ? JSON.parse(data) : {}); } catch (e) { reject(e); } });
    req.on('error', reject);
  });

  return http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x');
    const parts = url.pathname.split('/').filter(Boolean);
    try {
      if (parts[0] === 'api') {
        // /api/plans
        if (parts.length === 2 && parts[1] === 'plans' && req.method === 'GET') return json(res, 200, store.listPlans());
        if (parts.length === 2 && parts[1] === 'plans' && req.method === 'POST') {
          const body = await readBody(req);
          return json(res, 201, store.savePlan(body));
        }
        const planId = parts[2];
        const plan = store.getPlan(planId);
        if (parts[1] === 'plans' && !plan) return json(res, 404, { error: '方案不存在' });

        if (parts.length === 3 && req.method === 'GET') return json(res, 200, plan);
        if (parts.length === 3 && req.method === 'PUT') {
          const body = await readBody(req);
          return json(res, 200, store.savePlan({ ...plan, ...body, id: planId }));
        }
        if (parts[3] === 'schedule' && req.method === 'POST') return json(res, 200, schedule(plan, Date.now()));
        if (parts[3] === 'simulate' && req.method === 'POST') {
          const { taskId } = await readBody(req);
          const sched = schedule(plan, Date.now());
          return json(res, 200, simulateFailure(plan, sched.order, taskId));
        }
        if (parts[3] === 'rollback' && req.method === 'POST') {
          const sched = schedule(plan, Date.now());
          if (!sched.ok) return json(res, 422, sched);
          return json(res, 200, planRollback(plan, sched.order, Date.now()));
        }
        if (parts[3] === 'drill' && req.method === 'POST') return json(res, 200, await store.runDrill(planId));
        if (parts[3] === 'publish' && req.method === 'POST') {
          const result = await store.publish(planId);
          return json(res, result.ok ? 200 : 422, result);
        }
        return json(res, 404, { error: '未知接口' });
      }

      // 静态资源（前端构建产物）
      let file = path.join(DIST, url.pathname === '/' ? 'index.html' : url.pathname);
      if (!file.startsWith(DIST) || !existsSync(file)) file = path.join(DIST, 'index.html');
      const content = await readFile(file);
      res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
      res.end(content);
    } catch (e) {
      json(res, e.status || 500, { error: e.message });
    }
  });
}

if (process.argv[1] && process.argv[1].endsWith('index.js')) {
  const port = process.env.PORT || 4173;
  createServer().listen(port, () => console.log(`割接演练台已启动: http://localhost:${port}`));
}
