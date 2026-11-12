/**
 * 独立复核：机器人补位（HEAD 1910954）。
 * - ensureBots/addBot/fill 容量与 7 人拒绝
 * - 多人多局机器人行动合法性、无越权、无死循环、筹码守恒
 * - 摊牌前机器人底牌对真人不可见；摊牌后按规则公开
 * - 机器人破产后的单人局下一手（HEAD 已知边界）
 * - 简单策略统计（仅观察质量，不要求强 AI）
 *
 * 运行（exact HEAD 源码）：
 *   $env:TXP_ROOT="verification/head-1910954-clean"; node verification/recheck-bots-node.mjs
 */
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

const here = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const root = process.env.TXP_ROOT ? path.resolve(process.env.TXP_ROOT) : here;
const artifacts = path.join(here, 'verification', 'artifacts');
mkdirSync(artifacts, { recursive: true });

const tableMod = await import(pathToFileURL(path.join(root, 'src/game/table.js')).href);
const botMod = await import(pathToFileURL(path.join(root, 'src/game/bot.js')).href);
const { PokerTable, INITIAL_CHIPS } = tableMod;
const { chooseBotAction, estimateBotStrength } = botMod;

const checks = [];
const stats = { hands: 0, botActions: 0, actionTypes: {}, maxActionsPerHand: 0, illegal: 0 };
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
function rngFor(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function cardSet(cards) { return new Set(cards || []); }
function findCardPaths(obj, needles, base = '$') {
  const hits = [];
  const walk = (v, p) => {
    if (typeof v === 'string') { if (needles.has(v)) hits.push({ path: p, value: v }); return; }
    if (Array.isArray(v)) return v.forEach((x, i) => walk(x, `${p}[${i}]`));
    if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) walk(x, `${p}.${k}`);
  };
  walk(obj, base);
  return hits;
}
function makeBots(n) {
  const t = new PokerTable({ hostName: '真人房主', roomCode: 'BOTN01' });
  while (t.texas.room.getMemberCounts().total < n) t.addBot();
  return t;
}
function playHandWithBotChooser(t, seed) {
  const rng = rngFor(seed);
  let guard = 0;
  const actions = [];
  while (t.controllerStatus === 'in_hand' && guard++ < 250) {
    const activeId = t.getActivePlayerId();
    assert.ok(activeId, '进行中应有 active player');
    const state = t.getState(activeId);
    const action = chooseBotAction(state, rng);
    assert.ok(action, `should choose action for ${activeId}`);
    try {
      t.act(activeId, action);
    } catch (err) {
      stats.illegal += 1;
      throw new Error(`illegal action ${JSON.stringify(action)} by ${activeId}: ${err.message}`);
    }
    actions.push({ activeId, action, isBot: t.isBot(activeId) });
  }
  assert.equal(t.controllerStatus, 'between_hands', 'hand must end within guard');
  stats.hands += 1;
  stats.maxActionsPerHand = Math.max(stats.maxActionsPerHand, actions.length);
  for (const a of actions) {
    if (!a.isBot) continue;
    stats.botActions += 1;
    stats.actionTypes[a.action.type] = (stats.actionTypes[a.action.type] || 0) + 1;
  }
  return actions;
}

// ---------------------------------------------------------------------------
// 1. 单人补位 / 添加 / 补满 / 7 人
// ---------------------------------------------------------------------------
check('单人房 ensureBots(2) 自动补 1 个机器人并可直接开局', () => {
  const t = new PokerTable({ hostName: '单人房主', roomCode: 'BOT001' });
  assert.equal(t.getState(1).players.length, 1);
  t.ensureBots(2);
  const st = t.getState(1);
  assert.equal(st.players.length, 2);
  assert.equal(st.players.filter((p) => p.isBot).length, 1);
  const bot = st.players.find((p) => p.isBot);
  assert.ok(bot.seated && bot.connected && bot.chips === INITIAL_CHIPS);
  const hand = t.startHand();
  assert.equal(hand.status, 'playing');
  assert.equal(hand.players.length, 2);
  return { players: st.players.map((p) => [p.id, p.name, p.isBot]), pot: hand.pot.total };
});

check('addBot/fill 到 6 人（房主 + 5 机器人），第 7 个机器人与第 7 个真人被拒', () => {
  const t = new PokerTable({ hostName: '补位房主' });
  t.addBot();
  assert.equal(t.getState(1).players.length, 2);
  while (t.texas.room.getMemberCounts().total < 6) t.addBot();
  const st = t.getState(1);
  assert.equal(st.players.length, 6);
  assert.equal(st.players.filter((p) => p.isBot).length, 5);
  assert.ok(st.players.filter((p) => p.isBot).every((p) => p.isBot && p.connected));
  const names = st.players.map((p) => p.name);
  assert.equal(new Set(names).size, names.length, '昵称应唯一');
  assert.throws(() => t.addBot(), /房间已满/);
  assert.throws(() => t.addPlayer({ name: '第七人' }), /房间已满/);
  return { players: st.players.map((p) => [p.id, p.name, p.isBot]), names };
});

// ---------------------------------------------------------------------------
// 2. 多人数多局：机器人行动合法、无越权、无死循环、筹码守恒
// ---------------------------------------------------------------------------
check('2/3/4/6 人 × 5 个随机种子：机器人行动全部合法、有限步内结束、筹码守恒', () => {
  const perSize = {};
  for (const n of [2, 3, 4, 6]) {
    perSize[n] = [];
    for (let seed = 1; seed <= 5; seed += 1) {
      const t = makeBots(n);
      const startChips = t.getState(1).players.reduce((s, p) => s + p.chips, 0);
      const hand = t.startHand();
      const actions = playHandWithBotChooser(t, seed * 100 + n);
      const end = t.getState(1);
      const chips = end.players.reduce((s, p) => s + p.chips, 0);
      assert.equal(chips, startChips, `${n}p seed${seed} chips conservation`);
      assert.equal(end.result.awards.reduce((s, a) => s + a.amount, 0), end.result.potTotal);
      assert.ok(actions.length < 200);
      perSize[n].push({ seed, actions: actions.length, chips, awards: end.result.awards.length, pot: end.result.potTotal });
      void hand;
    }
  }
  return perSize;
});

check('越权反证：非 active 玩家（含机器人）调用 act 会被拒绝', () => {
  const t = makeBots(3);
  t.startHand();
  const active = t.getActivePlayerId();
  const other = t.getState(1).players.find((p) => p.seated && p.id !== active).id;
  assert.throws(() => t.act(other, { type: 'Check' }), /还没轮到|不能|轮到你/);
  return { active, other };
});

// ---------------------------------------------------------------------------
// 3. 机器人底牌隐私
// ---------------------------------------------------------------------------
check('隐私：摊牌前真人 state 不含机器人底牌；摊牌后按规则公开', () => {
  const t = makeBots(2);
  t.startHand();
  const bot = t.getState(1).players.find((p) => p.isBot);
  const botHoles = t.getState(bot.id).you.cards;
  assert.equal(botHoles.length, 2);
  const human = t.getState(1);
  assert.equal(human.players.find((p) => p.id === bot.id).cards, undefined);
  const leaks = findCardPaths(JSON.parse(JSON.stringify(human)), cardSet(botHoles));
  assert.deepEqual(leaks, [], `human state leaked bot cards: ${JSON.stringify(leaks)}`);
  // 用 check/call 推到摊牌
  let guard = 0;
  while (t.controllerStatus === 'in_hand' && guard++ < 100) {
    const id = t.getActivePlayerId();
    const a = t.getState(id).you.allowed;
    if (a.canCheck) t.act(id, { type: 'Check' });
    else if (a.canCall) t.act(id, { type: 'Call' });
    else t.act(id, { type: 'Fold' });
  }
  const end = t.getState(1);
  const botEnd = end.players.find((p) => p.id === bot.id);
  assert.equal(end.result.outcome, 'showdown');
  assert.equal(end.result.revealed.includes(bot.id), true);
  assert.ok(Array.isArray(botEnd.cards) && botEnd.cards.length === 2, 'showdown 应公开机器人底牌');
  return { botId: bot.id, botHoles, revealed: end.result.revealed, botEndCards: botEnd.cards };
});

// ---------------------------------------------------------------------------
// 4. 机器人破产后的单人下一手（HEAD 1910954 的边界）
// ---------------------------------------------------------------------------
check('边界：机器人筹码耗尽后，下一手是否可自动继续（HEAD 行为探测）', () => {
  const t = new PokerTable({ hostName: '破产探测', roomCode: 'BOTBUST' });
  t.ensureBots(2);
  t.startHand();
  playHandWithBotChooser(t, 42);
  const bot = t.getState(1).players.find((p) => p.isBot);
  t.__setChips(bot.id, 0);
  t.ensureBots(2);
  let error = null;
  let hand = null;
  try {
    hand = t.startHand();
  } catch (err) {
    error = err.message;
  }
  const state = t.getState(1);
  return {
    botId: bot.id,
    error,
    handStatus: hand?.status || null,
    bots: state.players.filter((p) => p.isBot).map((p) => [p.id, p.chips, p.seated]),
    hostSeated: state.players.find((p) => p.id === 1).seated,
  };
});

// ---------------------------------------------------------------------------
// 5. 策略统计/质量观察
// ---------------------------------------------------------------------------
check('策略统计：随机种子下机器人行动类型分布与牌力样例', () => {
  const t = makeBots(3);
  for (let seed = 1; seed <= 10; seed += 1) {
    t.ensureBots(3);
    if (t.controllerStatus !== 'idle') { try { t.startHand(); } catch { break; } }
    if (t.controllerStatus !== 'in_hand') break;
    playHandWithBotChooser(t, seed);
    if (t.controllerStatus !== 'between_hands') break;
  }
  const aa = estimateBotStrength({ you: { cards: ['sa', 'ha'] }, board: [] });
  const weak = estimateBotStrength({ you: { cards: ['s7', 'd2'] }, board: [] });
  return {
    hands: stats.hands,
    botActions: stats.botActions,
    actionTypes: stats.actionTypes,
    maxActionsPerHand: stats.maxActionsPerHand,
    preflopAA: aa,
    preflop72o: weak,
  };
});

const failed = checks.filter((c) => !c.ok);
const report = {
  generatedAt: new Date().toISOString(),
  root,
  head: '1910954',
  checks,
  stats,
  summary: { total: checks.length, passed: checks.length - failed.length, failed: failed.length },
};
writeFileSync(path.join(artifacts, `recheck-bots-node${process.env.TXP_OUT_SUFFIX || ''}.json`), JSON.stringify(report, null, 2));
console.log(`\n结果: ${report.summary.passed}/${report.summary.total} 通过, ${failed.length} 失败; 机器人行动 ${stats.botActions} 次, 类型 ${JSON.stringify(stats.actionTypes)}`);
process.exitCode = failed.length ? 1 : 0;
