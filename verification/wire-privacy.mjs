/**
 * 独立反证：真实双 BrowserContext + PeerJS，拦截房主 HostSession._send 的实际 DataConnection 消息，
 * 验证摊牌前发给玩家的 state 不含其他玩家底牌；摊牌后只公开未弃牌玩家；同时检查 UI DOM / 全局对象泄漏。
 * 另含玩家刷新 + 短时断网重连（带 wire 观察）。
 *
 * 运行：node verification/wire-privacy.mjs
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
const evidence = { startedAt: new Date().toISOString(), steps: [], wireMessages: 0, checks: [] };
const checks = [];
function check(name, fn) {
  try {
    const detail = fn();
    checks.push({ name, ok: true, detail });
    console.log(`PASS ${name}${detail ? ` :: ${JSON.stringify(detail)}` : ''}`);
  } catch (err) {
    checks.push({ name, ok: false, error: err?.stack || String(err) });
    console.log(`FAIL ${name}: ${err?.message || err}`);
  }
}
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
function display(card) {
  const t = cardText(card);
  return `${t.rank}${t.suit}`;
}
function findCardPaths(obj, cardSet, base = '$') {
  const hits = [];
  const walk = (v, p) => {
    if (typeof v === 'string') {
      if (cardSet.has(v)) hits.push({ path: p, value: v });
      return;
    }
    if (Array.isArray(v)) return v.forEach((x, i) => walk(x, `${p}[${i}]`));
    if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) walk(x, `${p}.${k}`);
  };
  walk(obj, base);
  return hits;
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
  const page = wire(await ctx.newPage(), label);
  return page;
}
async function engineHoles(hostPage) {
  return hostPage.evaluate(() => {
    const t = window.__txpTable;
    return t.texas.room.getPlayersBySeatStatus('on-set').map((p) => ({
      id: p.id,
      cards: t.texas.dealer.getHoleCardsForPlayer(p),
    }));
  });
}
async function visibleCardTexts(page) {
  return page.evaluate(() => [...document.querySelectorAll('.seat .seat-cards .card:not(.back), .community .card:not(.empty)')]
    .map((el) => el.innerText.replace(/\s+/g, '')));
}
function assertDomAllowed(page, label, holesMap, viewerId, board, extraAllowed = []) {
  return visibleCardTexts(page).then((texts) => {
    const allowed = [];
    for (const c of holesMap.get(viewerId) || []) allowed.push(display(c));
    for (const c of board || []) allowed.push(display(c));
    allowed.push(...extraAllowed);
    const expected = allowed.slice().sort();
    const actual = texts.slice().sort();
    const unexpected = actual.filter((t) => !expected.includes(t));
    assert.deepEqual(unexpected, [], `${label} DOM 出现未授权卡面: ${JSON.stringify(unexpected)}（实际 ${JSON.stringify(actual)}）`);
    return { viewerId, visible: actual, allowed: expected };
  });
}
async function clickIfVisible(page, action) {
  const loc = page.locator(`.action-bar [data-action="${action}"]`);
  if (await loc.isVisible().catch(() => false)) {
    await loc.click();
    return true;
  }
  return false;
}
async function actOnce(pages) {
  for (const p of pages) {
    for (const a of ['check', 'call']) {
      if (await clickIfVisible(p, a)) { await p.waitForTimeout(450); return a; }
    }
  }
  return null;
}

try {
  // ---- 1. 建房并安装 wire 拦截（必须在玩家加入前） ----
  const host = await newCtxPage('host');
  await host.goto(server.url, { waitUntil: 'domcontentloaded' });
  await host.fill('#host-name', '房主验收');
  await host.click('[data-action="create"]');
  await host.waitForSelector('.room-id .code', { timeout: 20000 });
  const code = (await host.locator('.room-id .code').innerText()).trim();
  const patch = await host.evaluate(() => {
    if (!window.__txpHost) return { ok: false, reason: 'window.__txpHost missing' };
    window.__txpWire = [];
    const proto = Object.getPrototypeOf(window.__txpHost);
    const orig = proto._send;
    proto._send = function (conn, payload) {
      try {
        window.__txpWire.push({
          pid: conn?.__playerId ?? null,
          t: payload?.t ?? null,
          payload: JSON.parse(JSON.stringify(payload)),
          at: Date.now(),
        });
      } catch (err) {
        window.__txpWire.push({ error: String(err) });
      }
      return orig.call(this, conn, payload);
    };
    return { ok: true };
  });
  assert.equal(patch.ok, true, JSON.stringify(patch));
  evidence.roomCode = code;
  evidence.steps.push({ step: 'host-created+wire-patched', code });

  // ---- 2. 玩家加入 ----
  const guest = await newCtxPage('guest');
  await guest.goto(`${server.url}/?r=${code}`, { waitUntil: 'domcontentloaded' });
  await guest.fill('#join-name', '玩家验收');
  await guest.click('[data-action="join"]');
  await guest.waitForSelector('.room-id .code', { timeout: 25000 });
  await host.waitForFunction(() => document.querySelectorAll('.player-row').length === 2, null, { timeout: 15000 });
  const roomMetaHost = await host.locator('.room-meta').innerText();
  const roomMetaGuest = await guest.locator('.room-meta').innerText();
  check('联机建立：双方数秒内互相看到 2/6 人', () => {
    assert.match(roomMetaHost, /2\/6 人在座/);
    assert.match(roomMetaGuest, /2\/6 人在座/);
    return { host: roomMetaHost.replace(/\n/g, ' | '), guest: roomMetaGuest.replace(/\n/g, ' | ') };
  });

  // ---- 3. 发牌，摊牌前 wire / DOM 隐私 ----
  await host.click('.table-overlay [data-action="start"]');
  await host.waitForFunction(() => {
    const el = document.querySelector('.stage-label');
    return el && el.innerText.includes('翻牌前');
  }, null, { timeout: 15000 });
  await host.waitForTimeout(600);
  const holes1 = await engineHoles(host);
  const holesMap1 = new Map(holes1.map((h) => [h.id, h.cards]));
  const welcome = await host.evaluate(() => window.__txpWire.find((m) => m.t === 'welcome' && m.pid));
  assert.ok(welcome, '应捕获 welcome 消息');
  const guestId = welcome.pid;
  const hostId = 1;
  assert.notEqual(guestId, hostId);
  const board1 = await host.evaluate(() => window.__txpTable.getState(1).board);
  const stage1 = (await host.locator('.stage-label').innerText()).trim();
  const wire1 = await host.evaluate(() => window.__txpWire);
  const guestStateMsgs = wire1.filter((m) => m.t === 'state' && m.pid === guestId);
  const playingMsgs = guestStateMsgs.filter((m) => m.payload.state?.status === 'playing');
  assert.ok(playingMsgs.length > 0, '应捕获发牌后发给玩家的 state 消息');

  check('隐私/wire：摊牌前发给玩家的 state 全部不含其他玩家底牌', () => {
    assert.equal(stage1, '翻牌前');
    const hidden = new Set();
    for (const [pid, cards] of holesMap1) if (pid !== guestId) cards.forEach((c) => hidden.add(c));
    const leaks = [];
    for (const m of playingMsgs) {
      const s = m.payload.state;
      assert.equal(s.you.id, guestId);
      assert.equal(s.players.find((p) => p.id === guestId).cards, undefined, '自己 cards 字段不应填（底牌走 you.cards）');
      assert.deepEqual([...s.you.cards].sort(), [...holesMap1.get(guestId)].sort(), 'you.cards 应为且仅为自己的底牌');
      for (const p of s.players) if (p.id !== guestId) assert.equal(p.cards, undefined, `其他玩家 ${p.id} cards 必须缺席/undefined`);
      const hits = findCardPaths(s, hidden);
      if (hits.length) leaks.push({ at: m.at, hits });
    }
    // 连发牌前的 state 一并扫描，确保也不含底牌
    for (const m of guestStateMsgs) {
      const hits = findCardPaths(m.payload.state, hidden);
      if (hits.length) leaks.push({ at: m.at, phase: 'pre-hand', hits });
    }
    assert.deepEqual(leaks, [], `wire 泄漏他人底牌: ${JSON.stringify(leaks)}`);
    return { playingMessages: playingMsgs.length, allToGuest: guestStateMsgs.length, totalWireMessages: wire1.length, guestId, hostHoles: holesMap1.get(hostId), guestHoles: holesMap1.get(guestId) };
  });

  await checkAsync('隐私/UI：房主与玩家 DOM 均未渲染对手底牌（卡面元素 + 全文 textContent）', async () => {
    const hostDom = await assertDomAllowed(host, 'host', holesMap1, hostId, board1);
    const guestDom = await assertDomAllowed(guest, 'guest', holesMap1, guestId, board1);
    // 更严格：把整页 textContent 去空白后扫描对手底牌的“牌面文本”
    for (const [label, page, viewer] of [['host', host, hostId], ['guest', guest, guestId]]) {
      const bodyText = await page.evaluate(() => document.body.textContent.replace(/\s+/g, ''));
      for (const [pid, cards] of holesMap1) {
        if (pid === viewer) continue;
        for (const c of cards) {
          const text = display(c);
          assert.equal(bodyText.includes(text), false, `${label} 页面全文出现对手 ${pid} 的底牌 ${text}`);
        }
      }
    }
    return { hostDom, guestDom };
  });

  await checkAsync('隐私/浏览器存储：玩家 localStorage 不含任何底牌/牌局状态', async () => {
    const stored = await guest.evaluate(() => {
      const out = {};
      for (let i = 0; i < localStorage.length; i += 1) {
        const k = localStorage.key(i);
        out[k] = localStorage.getItem(k);
      }
      return out;
    });
    const values = Object.entries(stored);
    for (const [pid, cards] of holesMap1) {
      for (const c of cards) {
        const text = display(c);
        for (const [k, v] of values) {
          assert.equal(String(v).includes(c), false, `localStorage[${k}] 含原始牌码 ${c}`);
          assert.equal(String(v).includes(text), false, `localStorage[${k}] 含牌面 ${text}`);
        }
      }
    }
    return { keys: Object.keys(stored), hasState: Object.keys(stored).some((k) => /state|table/i.test(k)) };
  });

  await checkAsync('隐私/全局：玩家页面不暴露牌桌/引擎对象', async () => {
    const r = await guest.evaluate(() => {
      const suspicious = Object.keys(window).filter((k) => /^__txp|poker|texas/i.test(k));
      return { __txpTable: typeof window.__txpTable, __txpHost: typeof window.__txpHost, suspicious };
    });
    assert.equal(r.__txpTable, 'undefined');
    assert.equal(r.__txpHost, 'undefined');
    return r;
  });

  await guest.screenshot({ path: path.join(artifacts, 'wire-01-preflop-guest.png'), fullPage: true });

  // ---- 4. 打到翻牌，然后玩家刷新（验证重连后仍保密、状态不丢） ----
  const hostCanCall = await host.locator('.action-bar [data-action="call"]').isVisible().catch(() => false);
  const guestCanCall = await guest.locator('.action-bar [data-action="call"]').isVisible().catch(() => false);
  assert.ok(hostCanCall || guestCanCall, '翻牌前应有一方可以跟注');
  const firstToAct = guestCanCall ? guest : host;
  const secondToAct = firstToAct === host ? guest : host;
  await firstToAct.click('.action-bar [data-action="call"]');
  await firstToAct.waitForTimeout(450);
  await secondToAct.click('.action-bar [data-action="check"]');
  await host.waitForTimeout(650);
  const beforeReload = {
    stage: (await guest.locator('.stage-label').innerText()).trim(),
    pot: (await guest.locator('.pot-amount').innerText()).trim(),
    chips: (await guest.locator('.seat.self .seat-chips').innerText()).trim(),
    hole: (await guest.locator('.seat.self .seat-cards .card').allTextContents()).map((s) => s.trim().replace(/\s+/g, '')),
  };
  await guest.reload({ waitUntil: 'domcontentloaded' });
  await guest.waitForSelector('.room-id .code', { timeout: 25000 });
  await guest.waitForTimeout(800);
  const afterReload = {
    stage: (await guest.locator('.stage-label').innerText()).trim(),
    pot: (await guest.locator('.pot-amount').innerText()).trim(),
    chips: (await guest.locator('.seat.self .seat-chips').innerText()).trim(),
    hole: (await guest.locator('.seat.self .seat-cards .card').allTextContents()).map((s) => s.trim().replace(/\s+/g, '')),
  };
  check('断线恢复/刷新：座位、筹码、底牌、当前街均恢复', () => {
    assert.equal(afterReload.stage, beforeReload.stage);
    assert.equal(afterReload.pot, beforeReload.pot);
    assert.equal(afterReload.chips, beforeReload.chips);
    assert.deepEqual(afterReload.hole, beforeReload.hole);
    return { beforeReload, afterReload };
  });
  const wireAfterReload = await host.evaluate(() => window.__txpWire);
  check('隐私/wire：刷新重连后的 state 仍不含他人底牌', () => {
    const hidden = new Set();
    for (const [pid, cards] of holesMap1) if (pid !== guestId) cards.forEach((c) => hidden.add(c));
    const recent = wireAfterReload.filter((m) => m.t === 'state' && m.pid === guestId);
    const leaks = [];
    for (const m of recent) {
      const hits = findCardPaths(m.payload.state, hidden);
      if (hits.length) leaks.push({ at: m.at, hits });
    }
    assert.deepEqual(leaks, []);
    return { totalToGuest: recent.length, leaks: 0 };
  });

  // ---- 5. 短时断网 2 秒再恢复 ----
  await guest.context().setOffline(true);
  await guest.waitForTimeout(2000);
  const duringOffline = await host.locator('.room-meta').innerText();
  await guest.context().setOffline(false);
  await guest.waitForFunction(() => {
    const el = document.querySelector('#net-pill');
    return el && el.innerText.includes('已连接');
  }, null, { timeout: 25000 });
  await guest.waitForTimeout(600);
  await checkAsync('断线恢复/短时断网：2 秒断网后自动重连，仍为翻牌且筹码不变', async () => {
    assert.match(duringOffline, /2\/6 人在座/);
    assert.equal((await guest.locator('.stage-label').innerText()).trim(), '翻牌');
    assert.equal((await guest.locator('.seat.self .seat-chips').innerText()).trim(), beforeReload.chips);
    return { duringOffline: duringOffline.replace(/\n/g, ' | '), pill: (await guest.locator('#net-pill').innerText()).trim() };
  });

  // ---- 6. 打到摊牌 ----
  for (let i = 0; i < 40; i += 1) {
    if (await host.locator('.action-bar [data-action="next"]').isVisible().catch(() => false)) break;
    const acted = await actOnce([host, guest]);
    if (!acted) await host.waitForTimeout(300);
  }
  assert.ok(await host.locator('.action-bar [data-action="next"]').isVisible().catch(() => false), '应到达摊牌');
  const finalHoles = await engineHoles(host);
  const finalHolesMap = new Map(finalHoles.map((h) => [h.id, h.cards]));
  const finalBoard = await host.evaluate(() => window.__txpTable.getState(1).board);
  const finalStateHost = await host.evaluate(() => window.__txpTable.getState(1));
  const finalStateGuest = await host.evaluate((gid) => window.__txpTable.getState(gid), guestId);
  const allNonFolded = finalStateHost.players.filter((p) => p.seated && p.status !== 'out').map((p) => p.id);

  check('摊牌/规则：自动判胜负 + awards 总和等于底池 + 公共牌 5 张', () => {
    assert.equal(finalStateHost.result.outcome, 'showdown');
    assert.equal(finalBoard.length, 5);
    const awardTotal = finalStateHost.result.awards.reduce((s, a) => s + a.amount, 0);
    assert.equal(awardTotal, finalStateHost.result.potTotal);
    assert.ok(finalStateHost.result.awards.length >= 1);
    return { awards: finalStateHost.result.awards, potTotal: finalStateHost.result.potTotal, board: finalBoard, nonFolded: allNonFolded };
  });

  check('隐私/摊牌后：双方 state 只公开未弃牌玩家底牌，弃牌者仍保密', () => {
    for (const [label, st] of [['host', finalStateHost], ['guest', finalStateGuest]]) {
      for (const pid of allNonFolded) {
        const p = st.players.find((x) => x.id === pid);
        assert.ok(Array.isArray(p.cards) && p.cards.length === 2, `${label} 应看到未弃牌玩家 ${pid} 底牌`);
        assert.deepEqual([...p.cards].sort(), [...finalHolesMap.get(pid)].sort());
      }
      const folded = st.players.filter((p) => p.seated && p.status === 'out');
      for (const p of folded) assert.equal(p.cards, undefined, `弃牌玩家 ${p.id} 不应公开`);
    }
    return { nonFolded: allNonFolded, revealed: finalStateHost.result.revealed };
  });

  await checkAsync('隐私/UI 摊牌后：玩家页面出现对手 2 张明牌且牌面与引擎一致', async () => {
    const guestOpp = (await guest.locator('.seat:not(.self) .seat-cards .card:not(.back)').allTextContents())
      .map((s) => s.trim().replace(/\s+/g, '')).sort();
    const hostHoles = finalHolesMap.get(hostId).map(display).sort();
    assert.deepEqual(guestOpp, hostHoles, '玩家应看到房主底牌');
    const hostOpp = (await host.locator('.seat:not(.self) .seat-cards .card:not(.back)').allTextContents())
      .map((s) => s.trim().replace(/\s+/g, '')).sort();
    const guestHoles = finalHolesMap.get(guestId).map(display).sort();
    assert.deepEqual(hostOpp, guestHoles, '房主应看到玩家底牌');
    return { guestSeesHost: guestOpp, hostSeesGuest: hostOpp };
  });

  // 全量 wire 最终复核
  const wireAll = await host.evaluate(() => window.__txpWire);
  const summary = {
    total: wireAll.length,
    byType: Object.fromEntries([...new Set(wireAll.map((m) => m.t))].map((t) => [t, wireAll.filter((m) => m.t === t).length])),
    toGuestStateCount: wireAll.filter((m) => m.t === 'state' && m.pid === guestId).length,
  };
  evidence.wireMessages = wireAll.length;
  evidence.wireSummary = summary;

  await host.screenshot({ path: path.join(artifacts, 'wire-02-showdown-host.png'), fullPage: true });
  await guest.screenshot({ path: path.join(artifacts, 'wire-03-showdown-guest.png'), fullPage: true });

  assert.equal(pageErrors.length, 0, `浏览器错误: ${pageErrors.join('\n')}`);
  evidence.finishedAt = new Date().toISOString();
  evidence.checks = checks;
  evidence.ok = checks.every((c) => c.ok);
  writeFileSync(path.join(artifacts, 'wire-privacy.json'), JSON.stringify(evidence, null, 2));
  console.log(`\n结果: ${checks.filter((c) => c.ok).length}/${checks.length} 通过; wire 消息 ${wireAll.length} 条`);
  if (!evidence.ok) process.exitCode = 1;
} catch (err) {
  console.error('FATAL', err);
  evidence.fatal = err?.stack || String(err);
  evidence.checks = checks;
  evidence.ok = false;
  writeFileSync(path.join(artifacts, 'wire-privacy.json'), JSON.stringify(evidence, null, 2));
  process.exitCode = 1;
} finally {
  for (const c of contexts) await c.close().catch(() => {});
  await browser.close().catch(() => {});
  await server.close().catch(() => {});
}
