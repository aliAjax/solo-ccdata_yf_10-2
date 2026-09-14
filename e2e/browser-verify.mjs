// 真实浏览器验证：完整走通 录入→排程→冲突定位→中断模拟→演练→回滚→发布/拒绝发布
import { chromium } from 'playwright';
import { mkdirSync, existsSync } from 'node:fs';
import assert from 'node:assert/strict';

// 无 root 环境下本地解压的 Chromium 系统库
const LOCAL_LIBS = ['/tmp/syslibs/root/lib/aarch64-linux-gnu', '/tmp/syslibs/root/usr/lib/aarch64-linux-gnu']
  .filter(existsSync).join(':');
if (LOCAL_LIBS) process.env.LD_LIBRARY_PATH = [LOCAL_LIBS, process.env.LD_LIBRARY_PATH].filter(Boolean).join(':');

const BASE = process.env.BASE_URL || 'http://localhost:4173';
mkdirSync('e2e/shots', { recursive: true });

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1600, height: 950 } });
const shot = (name) => page.screenshot({ path: `e2e/shots/${name}.png`, fullPage: true });
const step = (msg) => console.log(`  ✓ ${msg}`);

try {
  // 1. 打开演练台，任务列表渲染
  await page.goto(BASE, { waitUntil: 'networkidle' });
  await page.waitForSelector('[data-testid="task-item-T1"]');
  for (const id of ['T1', 'T2', 'T3', 'T4']) await page.waitForSelector(`[data-testid="task-item-${id}"]`);
  step('方案与任务列表加载成功（T1~T4）');

  // 2. 录入新任务（验证录入能力）
  await page.click('[data-testid="add-task"]');
  await page.waitForSelector('[data-testid="task-item-T5"]');
  await page.click('[data-testid="task-item-T5"] .danger, [data-testid="task-editor"] .danger'); // 删除，保持演示方案干净
  await page.waitForSelector('[data-testid="task-item-T5"]', { state: 'detached' });
  step('任务录入/删除可用');

  // 3. 依赖排程 → 执行顺序
  await page.click('[data-testid="btn-schedule"]');
  await page.waitForSelector('[data-testid="exec-order"]');
  const stepIds = await page.$$eval('[data-testid="exec-order"] .step', els =>
    els.map(e => e.getAttribute('data-testid')));
  assert.deepEqual(stepIds, ['step-T1', 'step-T2', 'step-T3', 'step-T4']);
  step(`依赖排程正确：${stepIds.join(' → ')}`);
  await shot('1-schedule');

  // 4. 选择 T2 模拟中断 → 受影响链路 / 替代路径 / 业务中断范围
  await page.click('[data-testid="simulate-T2"]');
  await page.waitForSelector('[data-testid="sim-result"]');
  const simText = await page.textContent('[data-testid="sim-result"]');
  assert.match(simText, /L6/, '应显示中断链路 L6');
  assert.match(simText, /替代路径：办公终端 → 交换机 B → 核心路由器 → 交换机 A → 数据库/, '办公业务应有替代路径');
  assert.match(simText, /降级/, '业务应降级');
  assert.match(simText, /业务验证|割接服务器链路/, '下游任务应受阻');
  const impactText = await page.textContent('[data-testid="business-impact"]');
  assert.match(impactText, /中断 0 · 降级 2 · 正常 1/);
  step('中断模拟：受影响链路 L6、级联 L3、替代路径与业务中断范围正确');
  await shot('2-simulate-T2');

  // 5. 模拟 T3 中断（无替代路径 → 业务中断）
  await page.click('[data-testid="simulate-T3"]');
  await page.waitForFunction(() => document.querySelector('[data-testid="sim-result"]')?.textContent.includes('无替代路径'));
  step('T3 中断：Web 访问业务中断（无替代路径）');
  await shot('3-simulate-T3');

  // 6. 完整演练 → 回滚顺序
  await page.click('[data-testid="btn-drill"]');
  await page.waitForSelector('[data-testid="rollback-order"]');
  const rbSeq = await page.$$eval('[data-testid="rollback-order"] .seq', els => els.map(e => e.textContent));
  assert.deepEqual(rbSeq, ['R1', 'R2', 'R3', 'R4']);
  const rbFirst = await page.textContent('[data-testid="rollback-order"] .step');
  assert.match(rbFirst, /业务验证/, '回滚应为执行逆序，T4 最先回滚');
  await page.waitForSelector('.badge.passed');
  step('演练通过，回滚顺序为执行逆序（R1=业务验证 …）');
  await shot('4-drill-rollback');

  // 7. 全部通过 → 发布成功
  await page.click('[data-testid="btn-publish"]');
  await page.waitForSelector('[data-testid="publish-result"].ok');
  step('发布成功');
  await shot('5-published');

  // 8. 制造循环依赖（T1 依赖 T4）→ 排程定位到具体任务
  await page.click('[data-testid="task-item-T1"]');
  const depGroup = page.locator('[data-testid="task-editor"] .check-group', { hasText: '依赖任务' });
  await depGroup.getByLabel('业务验证').check();
  await page.click('[data-testid="btn-schedule"]');
  await page.waitForSelector('[data-testid="error-CYCLE"]');
  const cycText = await page.textContent('[data-testid="error-CYCLE"]');
  for (const id of ['T1', 'T2', 'T3', 'T4']) assert.match(cycText, new RegExp(id), `循环依赖应定位到 ${id}`);
  step('循环依赖被检测并定位到 T1/T2/T3/T4');
  // 点击错误 → 定位高亮任务
  await page.click('[data-testid="error-CYCLE"]');
  await page.waitForSelector('.task-item.flagged');
  step('点击错误可定位高亮具体任务');
  await shot('6-cycle-located');

  // 9. 循环依赖下发布 → 拒绝并说明原因
  await page.click('[data-testid="btn-publish"]');
  await page.waitForSelector('[data-testid="publish-result"].refused');
  const refuseText = await page.textContent('[data-testid="publish-result"]');
  assert.match(refuseText, /循环依赖/);
  step('存在问题时发布被拒绝并说明原因');
  await shot('7-publish-refused');

  // 10. 修复后恢复：取消 T1 对 T4 的依赖 → 排程恢复
  await depGroup.getByLabel('业务验证').uncheck();
  await page.click('[data-testid="btn-schedule"]');
  await page.waitForSelector('[data-testid="exec-order"]');
  step('修复循环依赖后排程恢复正常');

  // 11. 恢复窗口不成立 → 拒绝发布（把 T1 恢复窗口截止改到过去）
  await page.click('[data-testid="task-item-T1"]');
  const editor = page.locator('[data-testid="task-editor"]');
  await editor.getByLabel('恢复窗口截止').fill('2020-01-01T00:00');
  await page.click('[data-testid="btn-publish"]');
  await page.waitForSelector('[data-testid="publish-result"].refused');
  const rwText = await page.textContent('[data-testid="publish-result"]');
  assert.match(rwText, /恢复窗口已过期/);
  assert.match(rwText, /配置备份/, '应定位到具体任务');
  step('恢复窗口不成立时拒绝发布并定位到任务');
  await shot('8-recovery-window-refused');

  console.log('\n全部浏览器验证通过 ✅');
} finally {
  await browser.close();
}
