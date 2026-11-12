/**
 * 独立反证：3 人真实联机，1 人弃牌后打到摊牌。
 * 验证 UI 只公开未弃牌玩家的底牌，弃牌玩家即使摊牌后也不向其他人显示。
 * 运行：node verification/fold-privacy-ui.mjs
 */
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startServer } from '../test/helpers/serve.mjs';
import { launchBrowser } from '../test/helpers/browser.mjs';
import { cardText } from '../src/game/table.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const artifacts = path.join(root, 'verification', 'artifacts');
mkdirSync(artifacts, { recursive: true });
const display = (c) => { const t = cardText(c); return `${t.rank}${t.suit}`; };
const server = await startServer(path.join(root, 'docs'));
const browser = await launchBrowser();
const contexts = [];
const errors = [];
async function newPage(label) {
  const ctx = await browser.newContext();
  contexts.push(ctx);
  const p = await ctx.newPage();
  p.on('pageerror', (e) => errors.push(`${label}: ${e.message}`));
  p.on('console', (m) => { if (m.type() === 'error') errors.push(`${label} console: ${m.text()}`); });
  return p;
}
async function clickIfVisible(page, action) {
  const loc = page.locator(`.action-bar [data-action="${action}"]`);
  if (await loc.isVisible().catch(() => false)) { await loc.click(); return true; }
  return false;
}
async function seats(page) {
  return page.evaluate(() => [...document.querySelectorAll('.seat')].map((s) => ({
    name: s.querySelector('.seat-name')?.innerText?.trim() || '',
    cards: [...s.querySelectorAll('.seat-cards .card:not(.back)')].map((e) => e.innerText.replace(/\s+/g, '')),
    hasBack: !!s.querySelector('.seat-cards .card.back'),
    folded: s.classList.contains('folded'),
  })));
}
const report = { startedAt: new Date().toISOString(), ok: false };
try {
  const host = await newPage('host');
  await host.goto(server.url, { waitUntil: 'domcontentloaded' });
  await host.fill('#host-name', '房主折叠测试');
  await host.click('[data-action="create"]');
  await host.waitForSelector('.room-id .code', { timeout: 25000 });
  const code = (await host.locator('.room-id .code').innerText()).trim();
  const join = async (name, label) => {
    const p = await newPage(label);
    await p.goto(`${server.url}/?r=${code}`, { waitUntil: 'domcontentloaded' });
    await p.fill('#join-name', name);
    await p.click('[data-action="join"]');
    await p.waitForSelector('.room-id .code', { timeout: 25000 });
    return p;
  };
  const g2 = await join('玩家甲', 'g2');
  const g3 = await join('弃牌玩家', 'g3');
  await host.waitForFunction(() => document.querySelectorAll('.player-row').length === 3, null, { timeout: 20000 });
  await host.click('.table-overlay [data-action="start"]');
  await host.waitForFunction(() => document.querySelector('.stage-label')?.innerText.includes('翻牌前'), null, { timeout: 20000 });
  await host.waitForTimeout(600);

  const engineHoles = await host.evaluate(() => {
    const t = window.__txpTable;
    return t.texas.room.getPlayersBySeatStatus('on-set').map((p) => ({
      id: p.id, name: p.getUserInfo().name, cards: t.texas.dealer.getHoleCardsForPlayer(p),
    }));
  });
  const foldedName = '弃牌玩家';
  const folded = engineHoles.find((h) => h.name === foldedName);
  assert.ok(folded, '应能找到弃牌玩家底牌');

  // 打到摊牌：弃牌玩家在翻前任意轮到时弃牌，其他人 check/call。
  let foldedDone = false;
  for (let step = 0; step < 60; step += 1) {
    if (await host.locator('.action-bar [data-action="next"]').isVisible().catch(() => false)) break;
    const stage = (await host.locator('.stage-label').innerText()).trim();
    let acted = false;
    if (!foldedDone && stage.includes('翻牌前')) {
      if (await clickIfVisible(g3, 'fold')) { foldedDone = true; acted = true; await g3.waitForTimeout(450); }
    }
    if (!acted) {
      for (const p of [host, g2]) {
        if (await clickIfVisible(p, 'check')) { acted = true; await p.waitForTimeout(400); break; }
        if (await clickIfVisible(p, 'call')) { acted = true; await p.waitForTimeout(400); break; }
      }
    }
    if (!acted) await host.waitForTimeout(250);
  }
  assert.equal(foldedDone, true, '弃牌玩家应已弃牌');
  await host.waitForFunction(() => !!document.querySelector('.action-bar [data-action="next"]'), null, { timeout: 20000 });
  await host.waitForTimeout(500);

  const hostSeats = await seats(host);
  const g2Seats = await seats(g2);
  const foldedSeatHost = hostSeats.find((s) => s.name === foldedName);
  const foldedSeatG2 = g2Seats.find((s) => s.name === foldedName);
  assert.equal(foldedSeatHost.folded, true);
  assert.deepEqual(foldedSeatHost.cards, [], '房主 UI 不应显示弃牌玩家明牌');
  assert.deepEqual(foldedSeatG2.cards, [], '其他玩家 UI 不应显示弃牌玩家明牌');

  const foldedText = folded.cards.map(display);
  for (const [label, page] of [['host', host], ['g2', g2]]) {
    const bodyText = await page.evaluate(() => document.body.textContent.replace(/\s+/g, ''));
    for (const t of foldedText) assert.equal(bodyText.includes(t), false, `${label} 页面出现弃牌玩家底牌 ${t}`);
  }

  // 未弃牌双方互相公开
  const hostSeesG2 = hostSeats.find((s) => s.name === '玩家甲')?.cards || [];
  const g2SeesHost = g2Seats.find((s) => s.name === '房主折叠测试')?.cards || [];
  const hostHoles = engineHoles.find((h) => h.name === '房主折叠测试').cards.map(display).sort();
  const g2Holes = engineHoles.find((h) => h.name === '玩家甲').cards.map(display).sort();
  assert.deepEqual(hostSeesG2.slice().sort(), g2Holes, '房主应看到未弃牌玩家的底牌');
  assert.deepEqual(g2SeesHost.slice().sort(), hostHoles, '玩家甲应看到房主的底牌');

  // 弃牌玩家自己的页面可以看自己的底牌（不算泄漏）
  const g3Seats = await seats(g3);
  const selfSeat = g3Seats.find((s) => s.name === foldedName);
  report.g3SelfCards = selfSeat.cards;
  report.engine = engineHoles;
  report.hostSeats = hostSeats;
  report.guestSeats = g2Seats;
  report.foldedHoles = folded.cards;
  report.ok = true;
  await host.screenshot({ path: path.join(artifacts, 'fold-01-showdown-host.png'), fullPage: true });
  await g2.screenshot({ path: path.join(artifacts, 'fold-02-showdown-other.png'), fullPage: true });
  await g3.screenshot({ path: path.join(artifacts, 'fold-03-folded-self.png'), fullPage: true });
  console.log(`PASS 弃牌隐私/UI: 房主与玩家甲均看不到 ${foldedName} 的底牌 ${folded.cards.join('/')}；未弃牌双方互相可见`);
  console.log(JSON.stringify({ hostSeesG2, g2SeesHost, g3SelfCards: selfSeat.cards }));
  assert.equal(errors.length, 0, `浏览器错误: ${errors.join('\n')}`);
} catch (err) {
  report.error = err?.stack || String(err);
  console.error('FAIL', err?.message || err);
  process.exitCode = 1;
} finally {
  report.finishedAt = new Date().toISOString();
  writeFileSync(path.join(artifacts, 'fold-privacy-ui.json'), JSON.stringify(report, null, 2));
  for (const c of contexts) await c.close().catch(() => {});
  await browser.close().catch(() => {});
  await server.close().catch(() => {});
}
