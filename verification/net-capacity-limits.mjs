/**
 * 独立反证：真实浏览器容量与已知边界。
 * A) 房主 + 5 玩家 = 6 人满房；第 7 人被拒；6 人可发牌，盲注/底池正确。
 * B) 刷新房主页面 → 房间丢失（房主回 landing），玩家无法再恢复连接。
 *
 * 运行：node verification/net-capacity-limits.mjs
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
const evidence = { startedAt: new Date().toISOString(), checks: [], steps: [] };
const checks = [];
async function checkAsync(name, fn) {
  try {
    const detail = await fn();
    checks.push({ name, ok: true, detail });
    console.log(`PASS ${name}${detail ? ` :: ${JSON.stringify(detail)}` : ''}`);
  } catch (err) {
    checks.push({ name, ok: false, error: err?.stack || String(err) });
    console.log(`FAIL ${name}: ${err?.message || err}`);
  }
}
const server = await startServer(path.join(root, 'docs'));
const browser = await launchBrowser();
const contexts = [];
const pageErrors = [];
function wire(page, label) {
  page.on('pageerror', (e) => pageErrors.push(`${label}: ${e.message}`));
  page.on('console', (m) => { if (m.type() === 'error') pageErrors.push(`${label} console: ${m.text()}`); });
  return page;
}
async function newCtxPage(label) {
  const ctx = await browser.newContext();
  contexts.push(ctx);
  return wire(await ctx.newPage(), label);
}
async function createRoom(name) {
  const page = await newCtxPage('host');
  await page.goto(server.url, { waitUntil: 'domcontentloaded' });
  await page.fill('#host-name', name);
  await page.click('[data-action="create"]');
  await page.waitForSelector('.room-id .code', { timeout: 25000 });
  const code = (await page.locator('.room-id .code').innerText()).trim();
  return { page, code };
}
async function joinGuest(code, name, label, expectRows) {
  let lastErr;
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    const page = await newCtxPage(`${label}-try${attempt}`);
    try {
      await page.goto(`${server.url}/?r=${code}`, { waitUntil: 'domcontentloaded' });
      await page.fill('#join-name', name);
      await page.click('[data-action="join"]');
      await page.waitForSelector('.room-id .code', { timeout: 30000 });
      if (expectRows) {
        await hostPage.waitForFunction((n) => document.querySelectorAll('.player-row').length >= n, expectRows, { timeout: 20000 });
      }
      return page;
    } catch (err) {
      lastErr = err;
      evidence.steps.push({ step: 'join-retry', label, attempt, error: String(err?.message || err) });
      await page.context().close().catch(() => {});
    }
  }
  throw lastErr;
}
let hostPage;

try {
  // ================= A. 6 人满房 + 第 7 人被拒 =================
  const { page: host, code } = await createRoom('房主六人');
  hostPage = host;
  const guests = [];
  for (let i = 2; i <= 6; i += 1) {
    const g = await joinGuest(code, `玩家${i}`, `guest${i}`, i);
    guests.push(g);
    evidence.steps.push({ step: 'guest-joined', seat: i });
  }
  await host.waitForFunction(() => document.querySelectorAll('.player-row').length === 6, null, { timeout: 15000 });
  const meta6 = await host.locator('.room-meta').innerText();
  const playerRows6 = await host.locator('.player-row .pc').allTextContents();
  const seatCount = await host.locator('.seat').count();

  await checkAsync('容量/6 人真实联机：房主 + 5 玩家全部入座，显示 6/6 人，初始筹码 1000', async () => {
    assert.match(meta6, /6\/6 人在座/);
    assert.equal(seatCount, 6, '牌桌应渲染 6 个座位');
    assert.deepEqual(playerRows6.map((x) => Number(String(x).replace(/[^\d]/g, ''))), [1000, 1000, 1000, 1000, 1000, 1000]);
    return { meta: meta6.replace(/\n/g, ' | '), seatCount, playerRows6 };
  });

  await host.click('.table-overlay [data-action="start"]');
  await host.waitForFunction(() => {
    const el = document.querySelector('.stage-label');
    return el && el.innerText.includes('翻牌前');
  }, null, { timeout: 20000 });
  await host.waitForTimeout(800);
  const pot6 = (await host.locator('.pot-amount').innerText()).trim();
  const hostOwnCards = await host.locator('.seat.self .seat-cards .card').count();
  const hostOppBacks = await host.locator('.seat:not(.self) .seat-cards .card.back').count();
  const lastGuest = guests[guests.length - 1];
  const guestOwnCards = await lastGuest.locator('.seat.self .seat-cards .card').count();
  const guestOppBacks = await lastGuest.locator('.seat:not(.self) .seat-cards .card.back').count();

  await checkAsync('容量/6 人发牌：盲注 10/20 扣成底池 30，6 家各 2 张底牌且对手只见牌背', async () => {
    assert.equal(pot6, '30');
    assert.equal(hostOwnCards, 2);
    assert.equal(hostOppBacks, 10, '房主应看到 5 名对手 × 2 张牌背');
    assert.equal(guestOwnCards, 2);
    assert.equal(guestOppBacks, 10, '玩家应看到 5 名对手 × 2 张牌背');
    return { pot6, hostOwnCards, hostOppBacks, guestOwnCards, guestOppBacks };
  });

  // 第 7 人
  const seventh = await newCtxPage('guest7');
  await seventh.goto(`${server.url}/?r=${code}`, { waitUntil: 'domcontentloaded' });
  await seventh.fill('#join-name', '第七人');
  await seventh.click('[data-action="join"]');
  let rejected = null;
  try {
    await seventh.waitForFunction(() => {
      const el = document.querySelector('.error-text');
      return el && el.innerText.trim().length > 0;
    }, null, { timeout: 25000 });
    rejected = (await seventh.locator('.error-text').innerText()).trim();
  } catch {
    rejected = `(未出现 error-text) body=${(await seventh.locator('body').innerText()).slice(0, 200)}`;
  }
  const seventhHasRoom = await seventh.locator('.room-id .code').count();
  const hostRowsAfter7 = await host.locator('.player-row').count();

  await checkAsync('容量/第 7 人：被拒绝并提示“房间已满”，房主仍为 6 人', async () => {
    assert.match(rejected, /房间已满/);
    assert.equal(seventhHasRoom, 0, '第 7 人不应进入房间');
    assert.equal(hostRowsAfter7, 6, '房主玩家列表仍应为 6 人');
    return { rejected, seventhHasRoom, hostRowsAfter7 };
  });

  await host.screenshot({ path: path.join(artifacts, 'capacity-01-six-players-host.png'), fullPage: true });
  await lastGuest.screenshot({ path: path.join(artifacts, 'capacity-02-six-players-guest.png'), fullPage: true });
  await seventh.screenshot({ path: path.join(artifacts, 'capacity-03-seventh-rejected.png'), fullPage: true });

  // 关闭满房相关上下文，避免影响后续
  for (const g of guests) await g.context().close().catch(() => {});
  await seventh.context().close().catch(() => {});
  await host.context().close().catch(() => {});

  // ================= B. 房主刷新丢房间 =================
  const { page: host2, code: code2 } = await createRoom('房主刷新测试');
  const guest2 = await newCtxPage('guest-refresh');
  await guest2.goto(`${server.url}/?r=${code2}`, { waitUntil: 'domcontentloaded' });
  await guest2.fill('#join-name', '玩家刷新');
  await guest2.click('[data-action="join"]');
  await guest2.waitForSelector('.room-id .code', { timeout: 25000 });
  await host2.waitForFunction(() => document.querySelectorAll('.player-row').length === 2, null, { timeout: 15000 });
  await guest2.waitForTimeout(500);

  await host2.reload({ waitUntil: 'domcontentloaded' });
  await host2.waitForTimeout(1500);
  const hostLanding = await host2.evaluate(() => ({
    hasRoomCode: !!document.querySelector('.room-id .code'),
    hasHero: !!document.querySelector('.landing .hero h1'),
    txpTable: typeof window.__txpTable,
    title: document.title,
  }));
  let pillText = '';
  let bannerVisible = false;
  let connectedAgain = false;
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    pillText = (await guest2.locator('#net-pill').innerText().catch(() => '')).trim();
    bannerVisible = await guest2.locator('#conn-banner').isVisible().catch(() => false);
    if (pillText && !pillText.includes('已连接')) break;
    await guest2.waitForTimeout(500);
  }
  // 再观察 6 秒，确认不会自行恢复
  await guest2.waitForTimeout(6000);
  const pillAfterWait = (await guest2.locator('#net-pill').innerText().catch(() => '')).trim();
  connectedAgain = pillAfterWait.includes('已连接');
  const guestStillShowsRoom = (await guest2.locator('.room-id .code').count()) > 0;

  await checkAsync('已知边界/房主刷新：房主回到 landing 且内存牌桌消失', async () => {
    assert.equal(hostLanding.hasRoomCode, false);
    assert.equal(hostLanding.hasHero, true);
    assert.equal(hostLanding.txpTable, 'undefined');
    return hostLanding;
  });

  await checkAsync('已知边界/房主刷新：玩家断开且无法恢复，座位状态保留在旧页面', async () => {
    assert.equal(connectedAgain, false, '房主刷新后玩家不应仍显示已连接');
    assert.ok(pillText.includes('重连') || bannerVisible, `应显示重连提示，实际 pill=${pillText} banner=${bannerVisible}`);
    assert.equal(guestStillShowsRoom, true, '玩家页面保留最后状态（不会清空），符合首版边界');
    return { pillText, pillAfterWait, bannerVisible, connectedAgain, guestStillShowsRoom };
  });

  await host2.screenshot({ path: path.join(artifacts, 'host-refresh-01-landing.png'), fullPage: true });
  await guest2.screenshot({ path: path.join(artifacts, 'host-refresh-02-guest-reconnecting.png'), fullPage: true });

  assert.equal(pageErrors.length, 0, `浏览器错误: ${pageErrors.join('\n')}`);
  evidence.finishedAt = new Date().toISOString();
  evidence.ok = checks.every((c) => c.ok);
  evidence.checks = checks;
  writeFileSync(path.join(artifacts, 'net-capacity-limits.json'), JSON.stringify(evidence, null, 2));
  console.log(`\n结果: ${checks.filter((c) => c.ok).length}/${checks.length} 通过`);
  if (!evidence.ok) process.exitCode = 1;
} catch (err) {
  console.error('FATAL', err);
  evidence.fatal = err?.stack || String(err);
  evidence.checks = checks;
  evidence.ok = false;
  writeFileSync(path.join(artifacts, 'net-capacity-limits.json'), JSON.stringify(evidence, null, 2));
  process.exitCode = 1;
} finally {
  for (const c of contexts) await c.close().catch(() => {});
  await browser.close().catch(() => {});
  await server.close().catch(() => {});
}
