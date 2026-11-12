import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startServer } from '../helpers/serve.mjs';
import { launchBrowser } from '../helpers/browser.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const artifacts = path.join(root, 'test', '.artifacts');
const report = {
  startedAt: new Date().toISOString(),
  scenarios: [],
};
let server;
let browser;
const openContexts = [];
const allErrors = [];

function wire(page, label) {
  page.on('pageerror', (err) => allErrors.push(`${label} pageerror: ${err.message || err}`));
  page.on('console', (msg) => {
    if (msg.type() === 'error') allErrors.push(`${label} console: ${msg.text()}`);
  });
  return page;
}

async function newPage(label, context = null) {
  const ctx = context || await browser.newContext();
  if (!context) openContexts.push(ctx);
  const page = await ctx.newPage();
  return wire(page, label);
}

async function createRoom(hostName) {
  const ctx = await browser.newContext();
  openContexts.push(ctx);
  const page = await newPage('host', ctx);
  await page.goto(server.url, { waitUntil: 'domcontentloaded' });
  await page.fill('#host-name', hostName);
  await page.click('[data-action="create"]');
  await page.waitForSelector('.room-id .code', { timeout: 20000 });
  const code = (await page.locator('.room-id .code').textContent()).trim();
  assert.match(code, /^[A-Z0-9]{6}$/);
  return { page, ctx, code };
}

async function joinRoom(code, name, label) {
  const ctx = await browser.newContext();
  openContexts.push(ctx);
  const page = await newPage(label, ctx);
  await page.goto(`${server.url}/?r=${code}`, { waitUntil: 'domcontentloaded' });
  await page.fill('#join-name', name);
  await page.click('[data-action="join"]');
  await page.waitForSelector('.room-id .code', { timeout: 20000 });
  return { page, ctx };
}

async function clickOneAction(page) {
  for (const action of ['check', 'call', 'fold']) {
    const loc = page.locator(`.action-bar [data-action="${action}"]`);
    if (await loc.isVisible().catch(() => false)) {
      await loc.click();
      return action;
    }
  }
  return null;
}

async function finishHand(host, guest) {
  for (let i = 0; i < 50; i += 1) {
    if (await host.locator('.action-bar [data-action="next"]').isVisible().catch(() => false)) return;
    let acted = false;
    for (const page of [host, guest]) {
      const action = await clickOneAction(page);
      if (action) {
        await page.waitForTimeout(420);
        acted = true;
        break;
      }
    }
    if (!acted) await host.waitForTimeout(250);
  }
  const dump = {
    hostStage: await host.locator('.stage-label').innerText().catch(() => ''),
    guestStage: await guest.locator('.stage-label').innerText().catch(() => ''),
    hostBar: await host.locator('.action-bar').innerText().catch(() => ''),
    guestBar: await guest.locator('.action-bar').innerText().catch(() => ''),
    hostPill: await host.locator('#net-pill').innerText().catch(() => ''),
    guestPill: await guest.locator('#net-pill').innerText().catch(() => ''),
  };
  throw new Error(`手牌在 50 步内没有结束: ${JSON.stringify(dump)}`);
}

async function scenario(name, fn) {
  const started = Date.now();
  try {
    const details = await fn();
    report.scenarios.push({ name, ok: true, ms: Date.now() - started, details });
    console.log(`✅ ${name} (${Date.now() - started}ms)`);
    return details;
  } catch (err) {
    report.scenarios.push({ name, ok: false, ms: Date.now() - started, error: err?.stack || String(err) });
    console.error(`❌ ${name}:`, err?.stack || err);
    throw err;
  }
}

async function main() {
  await mkdir(artifacts, { recursive: true });
  server = await startServer(path.join(root, 'docs'));
  browser = await launchBrowser();

  await scenario('联机建立 + 完整一手牌 + 底牌保密 + 断线恢复 + 下一手', async () => {
    const { page: host, code } = await createRoom('房主测试');
    const { page: guest } = await joinRoom(code, '小明', 'guest');
    await host.waitForSelector('.player-row');
    await guest.waitForSelector('.player-row');

    assert.match(await host.locator('.room-meta').innerText(), /2\/6 人在座/);
    assert.match(await guest.locator('.room-meta').innerText(), /2\/6 人在座/);
    assert.ok((await host.locator('body').innerText()).includes('小明'));
    assert.ok((await guest.locator('body').innerText()).includes('房主测试'));

    await host.click('.table-overlay [data-action="start"]');
    await host.waitForTimeout(700);
    assert.match(await host.locator('.stage-label').innerText(), /翻牌前/);
    assert.equal((await host.locator('.pot-amount').innerText()).trim(), '30');

    const privacy = {
      guestOwnCards: await guest.locator('.seat.self .seat-cards .card').count(),
      guestVisibleOpponentBacks: await guest.locator('.seat:not(.self) .seat-cards .card.back').count(),
    };
    assert.equal(privacy.guestOwnCards, 2);
    assert.equal(privacy.guestVisibleOpponentBacks, 2, '发牌后、摊牌前对手只能看到牌背');

    const guestHole = (await guest.locator('.seat.self .seat-cards .card').allTextContents())
      .map((s) => s.trim().replace(/\s+/g, ' '));
    assert.equal(guestHole.length, 2);

    // 单挑时按钮位（小盲）先行动，按钮位是随机的
    const firstToAct = (await guest.locator('.action-bar [data-action="call"]').isVisible().catch(() => false)) ? guest : host;
    const secondToAct = firstToAct === host ? guest : host;
    await firstToAct.click('.action-bar [data-action="call"]');
    await firstToAct.waitForTimeout(500);
    await secondToAct.click('.action-bar [data-action="check"]');
    await host.waitForTimeout(600);
    assert.match(await guest.locator('.stage-label').innerText(), /翻牌/);

    const beforeRefresh = {
      pot: (await guest.locator('.pot-amount').innerText()).trim(),
      chips: (await guest.locator('.seat.self .seat-chips').innerText()).trim(),
      hole: (await guest.locator('.seat.self .seat-cards .card').allTextContents())
        .map((s) => s.trim().replace(/\s+/g, ' ')),
    };
    assert.deepEqual(beforeRefresh.hole, guestHole, '重连前底牌应一致');

    // 刷新页面：凭 token 自动回座，应继续当前手牌
    await guest.reload({ waitUntil: 'domcontentloaded' });
    await guest.waitForSelector('.room-id .code', { timeout: 20000 });
    await guest.waitForTimeout(700);
    assert.match(await guest.locator('.stage-label').innerText(), /翻牌/);
    assert.equal((await guest.locator('.pot-amount').innerText()).trim(), beforeRefresh.pot);
    assert.equal((await guest.locator('.seat.self .seat-chips').innerText()).trim(), beforeRefresh.chips);
    assert.deepEqual(
      (await guest.locator('.seat.self .seat-cards .card').allTextContents()).map((s) => s.trim().replace(/\s+/g, ' ')),
      beforeRefresh.hole,
      '刷新后底牌与座位应恢复',
    );

    // 短暂断网再恢复
    await guest.context().setOffline(true);
    await guest.waitForTimeout(3500);
    await guest.context().setOffline(false);
    await guest.waitForFunction(() => {
      const pill = document.querySelector('#net-pill');
      return pill && pill.innerText.includes('已连接');
    }, null, { timeout: 20000 });
    assert.match(await guest.locator('.stage-label').innerText(), /翻牌/);
    assert.equal((await guest.locator('.seat.self .seat-chips').innerText()).trim(), beforeRefresh.chips);

    await finishHand(host, guest);
    assert.match(await host.locator('.room-meta').innerText(), /第 1 手结束/);
    assert.ok(await host.locator('.action-bar [data-action="next"]').isVisible());
    const awards = await host.locator('.action-bar .award').allTextContents();
    assert.ok(awards.length >= 1);
    const awardTotal = awards
      .map((x) => Number(String(x).replace(/[^\d]/g, '')))
      .reduce((a, b) => a + b, 0);
    assert.equal(awardTotal, 40, '本手奖励总和等于底池');
    const totalChips = (await host.locator('.player-row .pc').allTextContents())
      .map((x) => Number(String(x).replace(/[^\d]/g, '')))
      .reduce((a, b) => a + b, 0);
    assert.equal(totalChips, 2000, '筹码总量守恒');

    // 摊牌后双方底牌公开
    assert.equal(await host.locator('.seat:not(.self) .seat-cards .card.back').count(), 0);
    assert.equal(await guest.locator('.seat:not(.self) .seat-cards .card.back').count(), 0);
    assert.equal(await guest.locator('.seat:not(.self) .seat-cards .card').count(), 2);

    const buttonBefore = await host.locator('.seat:has(.tag.d) .seat-name').innerText();
    await host.click('.action-bar [data-action="next"]');
    await host.waitForTimeout(900);
    assert.match(await host.locator('.room-meta').innerText(), /第 2 手/);
    assert.equal(await host.locator('.community .card:not(.empty)').count(), 0);
    assert.equal((await host.locator('.pot-amount').innerText()).trim(), '30');
    const buttonAfter = await host.locator('.seat:has(.tag.d) .seat-name').innerText();
    assert.notEqual(buttonAfter, buttonBefore, '下一手庄家应移动');

    await host.screenshot({ path: path.join(artifacts, '01-hand2-host.png'), fullPage: true });
    await guest.screenshot({ path: path.join(artifacts, '01-hand2-guest.png'), fullPage: true });
    return { code, privacy, beforeRefresh, totalChips, buttonBefore, buttonAfter };
  });

  await scenario('边池：三人不等额全下，主池与边池分配正确', async () => {
    const { page: host, code } = await createRoom('房主');
    const { page: g2 } = await joinRoom(code, '小明', 'guest2');
    const { page: g3 } = await joinRoom(code, '小红', 'guest3');
    await host.waitForFunction(() => document.querySelectorAll('.player-row').length === 3);

    await host.evaluate(() => {
      window.__txpTable.__setNextButton(1);
      window.__txpTable.__setChips(1, 100);
      window.__txpTable.__setChips(2, 300);
      window.__txpTable.__setChips(3, 300);
      window.__txpTable.__setNextDeal({
        handPokes: [
          ['sk', 'hk'], // 2 号：KKK
          ['sq', 'hq'], // 3 号：QQQ
          ['ca', 'da'], // 1 号（房主）：AAA
        ],
        commonPokes: ['ha', 'ck', 'dq', 's2', 'h3'],
      });
    });

    await host.click('.table-overlay [data-action="start"]');
    await host.waitForFunction(() => !!document.querySelector('.action-bar [data-action="allin"]'), null, { timeout: 10000 });
    assert.equal((await host.locator('.player-row .pc').allTextContents()).join(','), '100,290,280');

    await host.click('.action-bar [data-action="allin"]');
    await g2.waitForFunction(() => !!document.querySelector('.action-bar [data-action="allin"]'), null, { timeout: 10000 });
    await g2.click('.action-bar [data-action="allin"]');
    await g3.waitForFunction(() => !!document.querySelector('.action-bar [data-action="allin"]'), null, { timeout: 10000 });
    await g3.click('.action-bar [data-action="allin"]');
    await host.waitForFunction(() => !!document.querySelector('.action-bar [data-action="next"]'), null, { timeout: 12000 });

    const awardTexts = await host.locator('.action-bar .award').allTextContents();
    assert.ok(awardTexts.some((t) => t.includes('房主') && t.includes('+300')), `主池应归房主：${awardTexts}`);
    assert.ok(awardTexts.some((t) => t.includes('小明') && t.includes('+400')), `边池应归小明：${awardTexts}`);
    const chips = Object.fromEntries(
      (await host.locator('.player-row').allInnerTexts()).map((row) => {
        const [head, ...rest] = row.split('\n');
        return [head.split(' · ')[0], Number(rest.join('').replace(/[^\d]/g, ''))];
      }),
    );
    assert.equal(chips['房主'], 300);
    assert.equal(chips['小明'], 400);
    assert.equal(chips['小红'], 0);
    assert.match(await host.locator('.pot-split').innerText(), /主池 300/);
    assert.match(await host.locator('.pot-split').innerText(), /边池 1 400/);
    await host.screenshot({ path: path.join(artifacts, '02-sidepot-host.png'), fullPage: true });
    await g3.screenshot({ path: path.join(artifacts, '02-sidepot-loser.png'), fullPage: true });
    return { code, awardTexts, chips };
  });

  await scenario('单人模式：自动补机器人、机器人自动行动、下一手继续', async () => {
    const { page: host, code } = await createRoom('单机房主');
    assert.ok(await host.locator('.table-overlay [data-action="start"]').isEnabled(), '单人房应能直接开始');
    await host.click('.table-overlay [data-action="start"]');
    await host.waitForFunction(() => document.querySelectorAll('.player-row').length === 2, null, { timeout: 15000 });
    await host.waitForTimeout(900);
    assert.match(await host.locator('.room-meta').innerText(), /1 机器人/);
    assert.equal(await host.locator('.tag.bot').count(), 1);
    assert.match(await host.locator('.stage-label').innerText(), /翻牌前/);

    await finishHand(host, host);
    assert.match(await host.locator('.room-meta').innerText(), /第 1 手结束/);
    assert.ok(await host.locator('.action-bar [data-action="next"]').isVisible());
    assert.ok((await host.locator('.action-bar .award').allTextContents()).length >= 1);

    await host.click('.action-bar [data-action="next"]');
    await host.waitForTimeout(900);
    assert.match(await host.locator('.room-meta').innerText(), /第 2 手/);
    assert.equal(await host.locator('.tag.bot').count(), 1);
    await host.screenshot({ path: path.join(artifacts, '03-bot-host.png'), fullPage: true });
    return { code, playerRows: await host.locator('.player-row').allInnerTexts() };
  });

  assert.equal(allErrors.length, 0, `浏览器错误：\n${allErrors.join('\n')}`);
  report.finishedAt = new Date().toISOString();
  report.ok = true;
  await writeFile(path.join(artifacts, 'acceptance-report.json'), JSON.stringify(report, null, 2));
  console.log(`\n验收全部通过。报告: ${path.relative(root, path.join(artifacts, 'acceptance-report.json'))}`);
}

main()
  .catch(async (err) => {
    report.finishedAt = new Date().toISOString();
    report.ok = false;
    report.errors = allErrors;
    await writeFile(path.join(artifacts, 'acceptance-report.json'), JSON.stringify(report, null, 2)).catch(() => {});
    console.error(err);
    process.exitCode = 1;
  })
  .finally(async () => {
    for (const ctx of openContexts) {
      try { await ctx.close(); } catch { /* ignore */ }
    }
    try { await browser?.close(); } catch { /* ignore */ }
    try { await server?.close(); } catch { /* ignore */ }
  });
