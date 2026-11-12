/**
 * d6a4601 复核：房主页面消失/关闭时，玩家页面必须出现 .conn-banner，
 * 且后续重连尝试不得误显示“已连接”。
 *
 * 运行：node verification/recheck-banner.mjs
 */
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startServer } from '../test/helpers/serve.mjs';
import { launchBrowser } from '../test/helpers/browser.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const artifacts = path.join(root, 'verification', 'artifacts');
mkdirSync(artifacts, { recursive: true });
const report = {
  head: 'd6a4601',
  startedAt: new Date().toISOString(),
  steps: [],
  timeline: [],
  falseConnectedSamples: [],
  errors: [],
};
const server = await startServer(path.join(root, 'docs'));
const browser = await launchBrowser();
const contexts = [];
const errors = [];
async function newPage(label) {
  const ctx = await browser.newContext();
  contexts.push(ctx);
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push(`${label}: ${e.message}`));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(`${label} console: ${m.text()}`); });
  return page;
}
async function snapshot(page) {
  return page.evaluate(() => {
    const banner = document.querySelector('#conn-banner');
    const pill = document.querySelector('#net-pill');
    return {
      bannerExists: !!banner,
      bannerVisible: !!banner && banner.offsetParent !== null,
      bannerText: banner ? banner.innerText.replace(/\s+/g, ' ').trim() : '',
      pill: pill ? pill.innerText.trim() : '',
      hasRoom: !!document.querySelector('.room-id .code'),
      stage: document.querySelector('.stage-label')?.innerText?.trim() || '',
    };
  });
}
try {
  const host = await newPage('host');
  await host.goto(server.url, { waitUntil: 'domcontentloaded' });
  await host.fill('#host-name', '房主消失复核');
  await host.click('[data-action="create"]');
  await host.waitForSelector('.room-id .code', { timeout: 25000 });
  const code = (await host.locator('.room-id .code').innerText()).trim();
  const guest = await newPage('guest');
  await guest.goto(`${server.url}/?r=${code}`, { waitUntil: 'domcontentloaded' });
  await guest.fill('#join-name', '玩家横幅复核');
  await guest.click('[data-action="join"]');
  await guest.waitForSelector('.room-id .code', { timeout: 25000 });
  await host.waitForFunction(() => document.querySelectorAll('.player-row').length === 2, null, { timeout: 20000 });

  // 开一手，确保是在牌局进行中关闭房主页
  await host.click('.table-overlay [data-action="start"]');
  await host.waitForFunction(() => document.querySelector('.stage-label')?.innerText.includes('翻牌前'), null, { timeout: 20000 });
  await host.waitForTimeout(600);
  const beforeClose = await snapshot(guest);
  report.steps.push({ step: 'before-host-close', ...beforeClose });
  assert.equal(beforeClose.bannerVisible, false, '正常连接时不应显示重连横幅');
  assert.ok(beforeClose.pill.includes('已连接'), `正常时玩家应显示已连接，实际: ${beforeClose.pill}`);

  // 房主页面消失/关闭
  const closedAt = Date.now();
  await host.close();
  report.steps.push({ step: 'host-page-closed', at: closedAt });

  // 等待横幅出现：页面被硬关闭时依赖 GuestSession 的 45s 心跳检测，给足 75s。
  let bannerSeenAt = null;
  let bannerSnapshot = null;
  const preBannerConnected = [];
  const deadline = Date.now() + 75000;
  while (Date.now() < deadline) {
    const s = await snapshot(guest);
    const ms = Date.now() - closedAt;
    report.timeline.push({ ms, ...s });
    if (s.bannerVisible && bannerSeenAt === null) {
      bannerSeenAt = Date.now();
      bannerSnapshot = s;
    }
    if (!bannerSeenAt && s.pill.includes('已连接')) preBannerConnected.push({ ms, ...s });
    if (bannerSeenAt) break;
    await guest.waitForTimeout(500);
  }
  assert.ok(bannerSeenAt, `房主关闭后 75s 内未出现 .conn-banner；最后快照: ${JSON.stringify(report.timeline[report.timeline.length - 1])}`);
  assert.ok(bannerSnapshot.pill.includes('重连') || bannerSnapshot.pill.includes('连接中'), `横幅出现时状态应异常，实际: ${bannerSnapshot.pill}`);
  assert.match(bannerSnapshot.bannerText, /网络连接中断|连接异常|正在自动重连|正在重连/);
  report.preBannerConnectedSamples = preBannerConnected.length;
  report.detectionLatencyMs = bannerSeenAt - closedAt;

  // 横幅出现后继续观察 12s：重连尝试不能误显示“已连接”
  const watchEnd = Date.now() + 12000;
  while (Date.now() < watchEnd) {
    const s = await snapshot(guest);
    const ms = Date.now() - closedAt;
    report.timeline.push({ ms, ...s });
    if (s.pill.includes('已连接')) report.falseConnectedSamples.push({ ms, ...s });
    await guest.waitForTimeout(300);
  }
  const after = await snapshot(guest);
  report.steps.push({ step: 'after-watch', ...after });
  assert.deepEqual(report.falseConnectedSamples, [], `横幅出现后仍误报“已连接”: ${JSON.stringify(report.falseConnectedSamples.slice(0, 3))}`);
  assert.equal(after.pill.includes('已连接'), false, `观察结束时不应显示已连接，实际: ${after.pill}`);
  assert.equal(after.bannerVisible, true, '观察结束时重连横幅应仍然可见');
  assert.equal(after.hasRoom, true, '玩家仍应保留最后牌桌画面（首版边界）');

  report.bannerSeenMs = bannerSeenAt - closedAt;
  report.bannerSnapshot = bannerSnapshot;
  report.after = after;
  report.ok = true;
  await guest.screenshot({ path: path.join(artifacts, 'recheck-banner-host-gone.png'), fullPage: true });
  console.log(`PASS 横幅: 房主页面关闭后 ${report.bannerSeenMs}ms 出现 .conn-banner（硬关闭依赖 45s 心跳）`);
  console.log(`  banner="${bannerSnapshot.bannerText}"`);
  console.log(`  pill=${bannerSnapshot.pill}; 横幅出现后观察 12s 未误报已连接；结束时 pill=${after.pill}`);
  assert.equal(errors.length, 0, `浏览器错误: ${errors.join('\n')}`);
} catch (err) {
  report.error = err?.stack || String(err);
  console.error('FAIL', err?.message || err);
  process.exitCode = 1;
} finally {
  report.finishedAt = new Date().toISOString();
  writeFileSync(path.join(artifacts, 'recheck-banner.json'), JSON.stringify(report, null, 2));
  for (const c of contexts) await c.close().catch(() => {});
  await browser.close().catch(() => {});
  await server.close().catch(() => {});
}
