/**
 * 独立复核：机器人补位（HEAD 1910954）真实浏览器 UI。
 * - 单人房直接开始 → 自动补 1 个 BOT
 * - 机器人自动行动、真人未行动时机器人不越权、可以连续打完 2 手
 * - 机器人底牌摊牌前不对真人 UI/state 公开
 * - “添加机器人”“补满 6 人”按钮 → 6 人（5 BOT），第 7 个真人被拒
 *
 * 运行（exact HEAD docs）：
 *   $env:TXP_ROOT="verification/head-1910954-clean"; node verification/recheck-bots-browser.mjs
 */
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startServer } from '../test/helpers/serve.mjs';
import { launchBrowser } from '../test/helpers/browser.mjs';
import { cardText } from '../src/game/table.js';

const here = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const root = process.env.TXP_ROOT ? path.resolve(process.env.TXP_ROOT) : here;
const artifacts = path.join(here, 'verification', 'artifacts');
mkdirSync(artifacts, { recursive: true });
const display = (card) => { const t = cardText(card); return `${t.rank}${t.suit}`; };
const checks = [];
const errors = [];
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
async function newPage(label) {
  const ctx = await browser.newContext();
  contexts.push(ctx);
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push(`${label}: ${e.message}`));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(`${label} console: ${m.text()}`); });
  return page;
}
async function createRoom(name) {
  const page = await newPage('host');
  await page.goto(server.url, { waitUntil: 'domcontentloaded' });
  await page.fill('#host-name', name);
  await page.click('[data-action="create"]');
  await page.waitForSelector('.room-id .code', { timeout: 25000 });
  const code = (await page.locator('.room-id .code').innerText()).trim();
  return { page, code };
}
async function joinRoom(code, name, label) {
  const page = await newPage(label);
  await page.goto(`${server.url}/?r=${code}`, { waitUntil: 'domcontentloaded' });
  await page.fill('#join-name', name);
  await page.click('[data-action="join"]');
  return page;
}
async function visible(page, selector) {
  return page.locator(selector).isVisible().catch(() => false);
}
async function clickHostAction(host) {
  for (const action of ['check', 'call', 'allin', 'fold']) {
    if (await visible(host, `.action-bar [data-action="${action}"]`)) {
      await host.click(`.action-bar [data-action="${action}"]`);
      return action;
    }
  }
  return null;
}
async function patchHost(host) {
  return host.evaluate(() => {
    const t = window.__txpTable;
    const h = window.__txpHost;
    window.__actLog = [];
    window.__schedLog = [];
    const origAct = t.act.bind(t);
    t.act = (pid, action) => {
      const entry = {
        pid, action, active: t.getActivePlayerId(), status: t.controllerStatus,
        stage: t.texas.controller.stage, isBot: t.isBot(pid), handNo: t.handNo, at: Date.now(), ok: true,
      };
      try {
        return origAct(pid, action);
      } catch (err) {
        entry.ok = false;
        entry.error = err.message;
        throw err;
      } finally {
        window.__actLog.push(entry);
      }
    };
    const origSched = h.scheduleBot.bind(h);
    h.scheduleBot = (delay) => {
      window.__schedLog.push({ at: Date.now(), active: t.getActivePlayerId(), status: t.controllerStatus });
      return origSched(delay);
    };
    return { patched: true };
  });
}
async function hostState(host) {
  return host.evaluate(() => window.__txpTable.getState(1));
}
async function playHand(host, label) {
  let outOfTurnViolations = 0;
  let humanWaitChecks = 0;
  const trace = [];
  for (let step = 0; step < 180; step += 1) {
    const traceEntry = await host.evaluate(() => {
      const t = window.__txpTable;
      return {
        status: t.controllerStatus, active: t.getActivePlayerId(), handNo: t.handNo,
        stage: t.texas.controller.stage, acts: window.__actLog.length,
        lastAct: window.__actLog.slice(-3),
        nextVisible: !!document.querySelector('.action-bar [data-action="next"]'),
        bar: document.querySelector('.action-bar')?.innerText?.replace(/\s+/g, ' ').trim() || '',
      };
    });
    trace.push(traceEntry);
    if (traceEntry.nextVisible) return { outOfTurnViolations, humanWaitChecks, steps: step };
    if (traceEntry.status !== 'in_hand') {
      if (traceEntry.status === 'between_hands') return { outOfTurnViolations, humanWaitChecks, steps: step };
      await host.waitForTimeout(250);
      continue;
    }
    if (traceEntry.active === 1) {
      // 真人回合：等待 1.2s，确认机器人没有越权行动
      const before = traceEntry.acts;
      await host.waitForTimeout(1200);
      const after = await host.evaluate(() => window.__actLog.length);
      humanWaitChecks += 1;
      if (after !== before) outOfTurnViolations += 1;
      const acted = await clickHostAction(host);
      if (!acted) throw new Error(`${label}: 真人回合没有可点击行动`);
      await host.waitForTimeout(350);
    } else {
      // 机器人回合：等待 active 变化或本手结束
      try {
        await host.waitForFunction((prev) => {
          const t = window.__txpTable;
          return t.getActivePlayerId() !== prev || t.controllerStatus !== 'in_hand';
        }, traceEntry.active, { timeout: 10000 });
      } catch (err) {
        const dump = await host.evaluate(() => ({
          state: window.__txpTable.getState(1),
          acts: window.__actLog.slice(-10),
          sched: window.__schedLog.slice(-10),
          botTimer: window.__txpHost.botTimer,
        }));
        throw new Error(`${label}: 等待机器人行动超时; trace=${JSON.stringify(trace.slice(-12))}; dump=${JSON.stringify(dump)}`);
      }
      await host.waitForTimeout(120);
    }
  }
  const dump = await host.evaluate(() => ({
    state: window.__txpTable.getState(1),
    acts: window.__actLog.slice(-20),
    sched: window.__schedLog.slice(-10),
    body: document.body.innerText.slice(0, 500),
  }));
  throw new Error(`${label}: 180 步内未结束; trace=${JSON.stringify(trace.slice(-12))}; dump=${JSON.stringify(dump)}`);
}

const report = { root, head: '1910954', startedAt: new Date().toISOString(), checks };
try {
  // ================= A. 单人房 + 2 手 =================
  const { page: host, code } = await createRoom('单人复核房主');
  await checkAsync('单人房：开始按钮可用，点击后自动补 1 个 BOT', async () => {
    assert.ok(await visible(host, '.table-overlay [data-action="start"]'));
    assert.equal(await host.locator('.table-overlay [data-action="start"]').isEnabled(), true);
    await patchHost(host);
    await host.click('.table-overlay [data-action="start"]');
    await host.waitForFunction(() => document.querySelectorAll('.player-row').length === 2, null, { timeout: 15000 });
    await host.waitForFunction(() => document.querySelector('.stage-label')?.innerText.includes('翻牌前'), null, { timeout: 15000 });
    const st = await hostState(host);
    const bots = st.players.filter((p) => p.isBot);
    assert.equal(bots.length, 1);
    assert.equal(st.players.length, 2);
    assert.match(await host.locator('.room-meta').innerText(), /1 机器人/);
    assert.equal(await host.locator('.tag.bot').count(), 1);
    return { bot: bots[0], roomMeta: (await host.locator('.room-meta').innerText()).replace(/\n/g, ' | ') };
  });

  const preflop = await host.evaluate(() => {
    const t = window.__txpTable;
    const st = t.getState(1);
    const bot = st.players.find((p) => p.isBot);
    return { state: st, botId: bot.id, botHoles: t.getState(bot.id).you.cards };
  });
  await checkAsync('隐私/UI：摊牌前 BOT 只有牌背，真人 state 不含 BOT 底牌', async () => {
    assert.equal(preflop.botHoles.length, 2);
    assert.equal(preflop.state.players.find((p) => p.id === preflop.botId).cards, undefined);
    assert.equal(preflop.state.you.cards.length, 2);
    assert.equal(await host.locator('.seat:not(.self) .seat-cards .card.back').count(), 2);
    assert.equal(await host.locator('.seat:not(.self) .seat-cards .card:not(.back)').count(), 0);
    const bodyText = await host.evaluate(() => document.body.textContent.replace(/\s+/g, ''));
    for (const c of preflop.botHoles) assert.equal(bodyText.includes(display(c)), false, `UI 出现 BOT 底牌 ${display(c)}`);
    await host.screenshot({ path: path.join(artifacts, 'bots-01-solo-preflop.png'), fullPage: true });
    return { botHoles: preflop.botHoles, hostHoles: preflop.state.you.cards, backs: 2 };
  });

  const hand1 = await playHand(host, 'hand1');
  const after1 = await host.evaluate(() => ({
    state: window.__txpTable.getState(1),
    actLog: window.__actLog.slice(),
    schedLog: window.__schedLog.slice(),
  }));
  await checkAsync('第 1 手：机器人自动行动，无越权，底池/筹码守恒', async () => {
    const st = after1.state;
    assert.equal(st.status, 'hand_over');
    assert.equal(st.handNo, 1);
    assert.equal(hand1.outOfTurnViolations, 0, '真人回合不应有机器人行动');
    assert.ok(hand1.humanWaitChecks >= 1, '应至少经历一次真人回合等待');
    const botActs = after1.actLog.filter((a) => a.isBot);
    assert.ok(botActs.length >= 1, '第 1 手应有机器人行动');
    for (const a of botActs) {
      assert.equal(a.ok, true, `机器人行动应合法: ${JSON.stringify(a)}`);
      assert.equal(a.pid, a.active, `机器人只能在 active 时行动: ${JSON.stringify(a)}`);
      assert.equal(a.status, 'in_hand', '机器人不应在手牌结束后行动');
    }
    for (const a of after1.actLog) assert.equal(a.ok, true, `所有 action 都应合法: ${JSON.stringify(a)}`);
    assert.equal(st.players.reduce((s, p) => s + p.chips, 0), 2000);
    assert.equal(st.result.awards.reduce((s, a) => s + a.amount, 0), st.result.potTotal);
    return { handNo: st.handNo, botActions: botActs.length, totalActions: after1.actLog.length, awards: st.result.awards, potTotal: st.result.potTotal };
  });

  await host.click('.action-bar [data-action="next"]');
  await host.waitForFunction(() => {
    const t = window.__txpTable;
    return t.handNo === 2 && (t.controllerStatus === 'in_hand' || t.controllerStatus === 'between_hands');
  }, null, { timeout: 15000 });
  await host.waitForTimeout(400);
  const hand2 = await playHand(host, 'hand2');
  const after2 = await host.evaluate(() => ({
    state: window.__txpTable.getState(1),
    actLog: window.__actLog.slice(),
    schedLog: window.__schedLog.slice(),
  }));
  await checkAsync('第 2 手：机器人继续自动行动，连续两手不卡住，筹码守恒', async () => {
    const st = after2.state;
    assert.equal(st.handNo, 2);
    assert.equal(st.status, 'hand_over');
    assert.equal(hand2.outOfTurnViolations, 0);
    const hand2Acts = after2.actLog.filter((a) => a.handNo === 2 && a.isBot);
    assert.ok(hand2Acts.length >= 1, '第 2 手应有机器人行动');
    for (const a of hand2Acts) {
      assert.equal(a.ok, true, `第 2 手机器人行动合法: ${JSON.stringify(a)}`);
      assert.equal(a.pid, a.active, '第 2 手机器人越权');
    }
    assert.equal(st.players.reduce((s, p) => s + p.chips, 0), 2000);
    assert.equal(st.result.awards.reduce((s, a) => s + a.amount, 0), st.result.potTotal);
    await host.screenshot({ path: path.join(artifacts, 'bots-02-solo-hand2.png'), fullPage: true });
    return {
      handNo: st.handNo,
      botActionsHand2: hand2Acts.length,
      totalActions: after2.actLog.length,
      chips: st.players.map((p) => [p.id, p.chips]),
      awards: st.result.awards,
    };
  });

  await checkAsync('调度/无重复：机器人行动次数有限、同一街同一玩家不会连续行动两次', async () => {
    const log = after2.actLog;
    const botActs = log.filter((a) => a.isBot);
    assert.ok(botActs.length < 100, `机器人行动次数异常: ${botActs.length}`);
    // 同一手、同一街内，同一玩家不能连续行动两次（跨街连续行动是合法的，例如单挑 BB）
    for (let i = 1; i < log.length; i += 1) {
      if (log[i].handNo === log[i - 1].handNo && log[i].stage === log[i - 1].stage && log[i].pid === log[i - 1].pid) {
        assert.fail(`同一手同一街玩家 ${log[i].pid} 连续行动两次: ${JSON.stringify(log[i - 1])} -> ${JSON.stringify(log[i])}`);
      }
    }
    // 时间戳唯一，排除同一回调重复发送
    const stamps = botActs.map((a) => a.at);
    assert.equal(new Set(stamps).size, stamps.length, '机器人 action 时间戳应唯一');
    assert.ok(after2.schedLog.length > 0, '应有 scheduleBot 调用记录');
    return { botActions: botActs.length, totalActions: log.length, schedCalls: after2.schedLog.length, stages: [...new Set(log.map((a) => a.stage))] };
  });

  // ================= B. 添加机器人 / 补满 6 人 / 第 7 人 =================
  const { page: host2, code: code2 } = await createRoom('补位复核房主');
  await host2.waitForSelector('.room-id .code', { timeout: 25000 });
  await checkAsync('“添加机器人”按钮：房主单人房 → 2 人（1 BOT）', async () => {
    await host2.click('.table-overlay [data-action="add-bot"]');
    await host2.waitForFunction(() => document.querySelectorAll('.player-row').length === 2, null, { timeout: 10000 });
    const st = await host2.evaluate(() => window.__txpTable.getState(1));
    assert.equal(st.players.length, 2);
    assert.equal(st.players.filter((p) => p.isBot).length, 1);
    assert.match(await host2.locator('.room-meta').innerText(), /1 机器人/);
    return { players: st.players.map((p) => [p.id, p.name, p.isBot]) };
  });

  await checkAsync('“补满 6 人”按钮：房主 + 5 BOT = 6/6', async () => {
    await host2.click('.side-panel [data-action="fill-bots"]');
    await host2.waitForFunction(() => document.querySelectorAll('.player-row').length === 6, null, { timeout: 15000 });
    const st = await host2.evaluate(() => window.__txpTable.getState(1));
    const meta = (await host2.locator('.room-meta').innerText()).replace(/\n/g, ' | ');
    assert.equal(st.players.length, 6);
    assert.equal(st.players.filter((p) => p.isBot).length, 5);
    assert.equal(await host2.locator('.tag.bot').count(), 5);
    assert.match(meta, /6\/6 人在座/);
    assert.match(meta, /5 机器人/);
    assert.equal(st.players.reduce((s, p) => s + p.chips, 0), 6000);
    await host2.screenshot({ path: path.join(artifacts, 'bots-03-six-players.png'), fullPage: true });
    return { meta, bots: 5, players: st.players.map((p) => [p.id, p.name, p.isBot, p.chips]) };
  });

  await checkAsync('第 7 个真人加入 6 人（含 5 BOT）房间：被拒“房间已满”', async () => {
    const seventh = await joinRoom(code2, '第七人', 'guest7');
    try {
      await seventh.waitForFunction(() => {
        const el = document.querySelector('.error-text');
        return el && el.innerText.trim().length > 0;
      }, null, { timeout: 20000 });
      const errorText = (await seventh.locator('.error-text').innerText()).trim();
      assert.match(errorText, /房间已满/);
      assert.equal(await seventh.locator('.room-id .code').count(), 0);
      const rows = await host2.locator('.player-row').count();
      assert.equal(rows, 6);
      return { errorText, hostRows: rows };
    } finally {
      await seventh.context().close().catch(() => {});
    }
  });

  assert.equal(errors.length, 0, `浏览器错误: ${errors.join('\n')}`);
  report.finishedAt = new Date().toISOString();
  report.ok = checks.every((c) => c.ok);
  report.code = code;
  report.code2 = code2;
  writeFileSync(path.join(artifacts, 'recheck-bots-browser.json'), JSON.stringify(report, null, 2));
  console.log(`\n结果: ${checks.filter((c) => c.ok).length}/${checks.length} 通过`);
  if (!report.ok) process.exitCode = 1;
} catch (err) {
  console.error('FATAL', err);
  report.fatal = err?.stack || String(err);
  report.finishedAt = new Date().toISOString();
  report.ok = false;
  writeFileSync(path.join(artifacts, 'recheck-bots-browser.json'), JSON.stringify(report, null, 2));
  process.exitCode = 1;
} finally {
  for (const c of contexts) await c.close().catch(() => {});
  await browser.close().catch(() => {});
  await server.close().catch(() => {});
}
