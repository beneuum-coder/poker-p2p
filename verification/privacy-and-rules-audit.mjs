/**
 * 独立验收脚本（不修改交付代码）：
 * 1) 对 PokerTable.getState(viewerId) 的投影做递归扫描，检查摊牌前/弃牌结束/摊牌后
 *    是否泄漏其他玩家底牌（含 result.bestPokes 等所有字段路径）。
 * 2) 规则/容量/筹码守恒/庄家移动/边池/平分底池/全下跑马。
 *
 * 运行：node verification/privacy-and-rules-audit.mjs
 */
import assert from 'node:assert/strict';
import { writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PokerTable, computeSidePots, MAX_PLAYERS, INITIAL_CHIPS, BIG_BLIND } from '../src/game/table.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const artifacts = path.join(root, 'verification', 'artifacts');
mkdirSync(artifacts, { recursive: true });

const findings = [];
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

/** 递归找出对象里所有等于某张牌的字符串值，返回 {path,value}。 */
function findCardPaths(obj, cardSet, base = '$') {
  const hits = [];
  const walk = (v, p) => {
    if (typeof v === 'string') {
      if (cardSet.has(v)) hits.push({ path: p, value: v });
      return;
    }
    if (Array.isArray(v)) return v.forEach((x, i) => walk(x, `${p}[${i}]`));
    if (v && typeof v === 'object') {
      for (const [k, x] of Object.entries(v)) walk(x, `${p}.${k}`);
    }
  };
  walk(obj, base);
  return hits;
}

function engineHoles(table) {
  const map = new Map();
  for (const p of table.texas.room.getPlayersBySeatStatus('on-set')) {
    map.set(p.id, table.texas.dealer.getHoleCardsForPlayer(p) || []);
  }
  return map;
}

function stateJson(table, viewerId) {
  return JSON.parse(JSON.stringify(table.getState(viewerId)));
}

function allSeated(table) {
  return table.texas.room.getPlayersBySeatStatus('on-set').map((p) => p.id);
}

function passive(table, playerId) {
  const st = table.getState(playerId);
  assert.equal(st.activePlayerId, playerId, `轮次应为 ${playerId}, 实际 ${st.activePlayerId}`);
  const a = st.you.allowed;
  if (!a) throw new Error('行动玩家缺少 allowed');
  if (a.canCheck) table.act(playerId, { type: 'Check' });
  else if (a.canCall) table.act(playerId, { type: 'Call' });
  else table.act(playerId, { type: 'Fold' });
}

function playPassiveToEnd(table, maxSteps = 200) {
  let steps = 0;
  while (table.controllerStatus === 'in_hand' && steps < maxSteps) {
    const st = table.getState(table.hostId);
    passive(table, st.activePlayerId);
    steps += 1;
  }
  assert.equal(table.controllerStatus, 'between_hands', `${maxSteps} 步内应结束本手`);
  return steps;
}

function totalChips(table) {
  return table.getState(table.hostId).players.reduce((s, p) => s + p.chips, 0)
    + table.getState(table.hostId).pot.total;
}

function makeTable(n, { hostName = '房主', roomCode = 'AUDIT1', hostId = 1 } = {}) {
  const t = new PokerTable({ hostName, roomCode });
  for (let i = 2; i <= n; i += 1) t.addPlayer({ name: `玩家${i}` });
  return t;
}

// ---------------------------------------------------------------------------
// A. 摊牌前隐私（每个 street 都扫描全部观战者投影）
// ---------------------------------------------------------------------------
check('隐私/摊牌前：所有观战者投影不含他人底牌（逐街扫描 + 全字段递归）', () => {
  const t = makeTable(3);
  t.__setNextButton(1);
  t.__setNextDeal({
    handPokes: [
      ['sa', 'ha'], // 2
      ['sk', 'hk'], // 3
      ['sq', 'hq'], // 1
    ],
    commonPokes: ['c2', 'd7', 's9', 'ct', 'dj'],
  });
  t.startHand();
  const holes = engineHoles(t);
  const stagesSeen = [];
  let steps = 0;
  while (t.controllerStatus === 'in_hand' && steps < 200) {
    const st0 = t.getState(1);
    stagesSeen.push(st0.stage);
    for (const viewer of allSeated(t)) {
      const state = stateJson(t, viewer);
      const own = new Set(holes.get(viewer) || []);
      const hidden = new Set();
      for (const [pid, cards] of holes) if (pid !== viewer) cards.forEach((c) => hidden.add(c));
      const hits = findCardPaths(state, hidden).filter((h) => !own.has(h.value));
      assert.deepEqual(hits, [], `阶段 ${st0.stage} viewer=${viewer} 泄漏他人底牌: ${JSON.stringify(hits)}`);
      assert.equal(state.you.cards.length, 2, `viewer=${viewer} 应能看到自己 2 张底牌`);
      assert.deepEqual([...state.you.cards].sort(), [...holes.get(viewer)].sort(), '自己底牌应精确等于引擎底牌');
      const others = state.players.filter((p) => p.id !== viewer);
      for (const p of others) {
        assert.equal(p.cards, undefined, `摊牌前 players[${p.id}].cards 必须为 undefined`);
      }
    }
    passive(t, t.getState(1).activePlayerId);
    steps += 1;
  }
  const final = t.getState(1);
  assert.equal(final.result.outcome, 'showdown');
  return { stagesSeen: [...new Set(stagesSeen)], steps, holes: Object.fromEntries(holes) };
});

// ---------------------------------------------------------------------------
// B. 摊牌后：未弃牌玩家公开，弃牌玩家不公开
// ---------------------------------------------------------------------------
check('隐私/摊牌后：仅未弃牌玩家公开底牌，弃牌玩家仍保密', () => {
  const t = makeTable(3);
  t.__setNextButton(1);
  t.__setNextDeal({
    handPokes: [
      ['sa', 'ha'], // 2
      ['sk', 'hk'], // 3
      ['sq', 'hq'], // 1
    ],
    commonPokes: ['c2', 'd7', 's9', 'ct', 'dj'],
  });
  t.startHand();
  // 翻牌圈让 2 号弃牌，其余过牌到摊牌
  let steps = 0;
  while (t.controllerStatus === 'in_hand' && steps < 200) {
    const st = t.getState(t.hostId);
    if (st.stage === 'flop' && st.activePlayerId === 2) {
      t.act(2, { type: 'Fold' });
    } else {
      passive(t, st.activePlayerId);
    }
    steps += 1;
  }
  assert.equal(t.controllerStatus, 'between_hands');
  const final = t.getState(1);
  assert.equal(final.result.outcome, 'showdown');
  assert.equal(final.result.revealed.length, 2, '只有 2 名未弃牌玩家公开');
  const holes = engineHoles(t);
  const foldedHoles = holes.get(2);
  for (const viewer of [1, 3, 2]) {
    const state = stateJson(t, viewer);
    for (const pid of [1, 3]) {
      const p = state.players.find((x) => x.id === pid);
      assert.ok(Array.isArray(p.cards) && p.cards.length === 2, `viewer=${viewer} 应看到未弃牌玩家 ${pid} 底牌`);
      assert.deepEqual([...p.cards].sort(), [...holes.get(pid)].sort());
    }
    assert.equal(state.players.find((x) => x.id === 2).cards, undefined, '弃牌玩家 players[].cards 不应公开');
    if (viewer !== 2) {
      const hits = findCardPaths(state, new Set(foldedHoles));
      assert.deepEqual(hits, [], `viewer=${viewer} 可见弃牌玩家底牌: ${JSON.stringify(hits)}`);
    }
  }
  return {
    outcome: final.result.outcome,
    revealed: final.result.revealed,
    foldedHoles,
    bestPokes: final.result.bestPokes,
    bestRankCategory: final.result.bestRankCategory,
  };
});

// ---------------------------------------------------------------------------
// C. 弃牌结束（fold_win）：不得通过 result.bestPokes 等字段泄漏赢家底牌
// ---------------------------------------------------------------------------
check('隐私/弃牌结束：任何字段（含 result.bestPokes）不含赢家底牌', () => {
  const t = makeTable(3);
  t.__setNextButton(1);
  t.__setNextDeal({
    handPokes: [
      ['sa', 'ha'], // 2
      ['sk', 'hk'], // 3
      ['sq', 'hq'], // 1
    ],
    commonPokes: ['c2', 'd7', 's9', 'ct', 'dj'],
  });
  t.startHand();
  const holes = engineHoles(t);
  let steps = 0;
  while (t.controllerStatus === 'in_hand' && steps < 20) {
    t.act(t.getState(1).activePlayerId, { type: 'Fold' });
    steps += 1;
  }
  assert.equal(t.controllerStatus, 'between_hands');
  const final = t.getState(1);
  assert.equal(final.result.outcome, 'fold_win');
  const winner = final.result.awards[0]?.userId;
  assert.ok(winner, '应有赢家');
  const winnerHoles = holes.get(winner);
  const leaks = [];
  for (const viewer of allSeated(t)) {
    if (viewer === winner) continue;
    const state = stateJson(t, viewer);
    const hits = findCardPaths(state, new Set(winnerHoles));
    if (hits.length) leaks.push({ viewer, hits });
  }
  assert.deepEqual(leaks, [], `弃牌结束后向输家泄漏赢家底牌: ${JSON.stringify(leaks)}`);
  return {
    winner,
    winnerHoles,
    bestPokes: final.result.bestPokes,
    bestRankCategory: final.result.bestRankCategory,
    resultKeys: Object.keys(final.result),
  };
});

// ---------------------------------------------------------------------------
// D. 2–6 人：初始筹码 1000、盲注 10/20、每家起始底池 30、筹码守恒
// ---------------------------------------------------------------------------
for (let n = 2; n <= 6; n += 1) {
  check(`容量/${n} 人：入座、初始筹码 ${INITIAL_CHIPS}、盲注 ${BIG_BLIND / 2}/${BIG_BLIND}、底池 30`, () => {
    const t = makeTable(n);
    const lobby = t.getState(1);
    assert.equal(lobby.players.length, n);
    assert.ok(lobby.players.every((p) => p.seated));
    assert.ok(lobby.players.every((p) => p.chips === INITIAL_CHIPS));
    const start = t.startHand();
    assert.equal(start.status, 'playing');
    assert.equal(start.pot.total, 30, '翻牌前底池应为 10+20');
    assert.equal(totalChips(t), n * INITIAL_CHIPS, `筹码+底池应守恒为 ${n * INITIAL_CHIPS}`);
    // 单挑时按钮位兼任小盲（role=btn, bet=10），因此按实际下注额而非 role 校验盲注。
    const posted = start.players.filter((p) => p.bet > 0);
    assert.equal(posted.length, 2, '应有 2 家 posting blinds');
    assert.deepEqual(posted.map((p) => p.bet).sort((a, b) => a - b), [10, 20]);
    if (n === 2) {
      assert.equal(start.players.find((p) => p.role === 'btn').bet, 10, '单挑按钮位应下小盲 10');
      assert.equal(start.players.find((p) => p.role === 'bb').bet, 20);
    } else {
      assert.equal(start.players.find((p) => p.role === 'sb').bet, 10);
      assert.equal(start.players.find((p) => p.role === 'bb').bet, 20);
    }
    assert.ok(start.you.cards.length === 2);
    playPassiveToEnd(t);
    const end = t.getState(1);
    assert.equal(end.result.outcome, 'showdown');
    assert.equal(end.result.awards.reduce((s, a) => s + a.amount, 0), end.result.potTotal);
    assert.equal(end.players.reduce((s, p) => s + p.chips, 0), n * INITIAL_CHIPS);
    return { n, potStart: 30, awards: end.result.awards };
  });
}

check('容量/7 人：第 7 人被拒绝（房间上限 6）', () => {
  const t = makeTable(6);
  assert.equal(t.getState(1).players.length, 6);
  assert.throws(() => t.addPlayer({ name: '第七人' }), /房间已满/);
  return { maxPlayers: MAX_PLAYERS, playerCount: t.getState(1).players.length };
});

// ---------------------------------------------------------------------------
// E. 下一手：庄家移动、底池重置、筹码守恒（2/3/6 人）
// ---------------------------------------------------------------------------
for (const n of [2, 3, 6]) {
  check(`下一手/${n} 人：庄家移动、底池重置为 30、筹码守恒`, () => {
    const t = makeTable(n);
    t.startHand();
    playPassiveToEnd(t);
    const before = t.getState(1);
    const oldBtn = before.players.find((p) => p.role === 'btn').id;
    const chipsAfter = before.players.map((p) => p.chips);
    const next = t.startHand();
    assert.equal(next.handNo, 2);
    assert.equal(next.status, 'playing');
    assert.equal(next.board.length, 0);
    assert.equal(next.pot.total, 30);
    const newBtn = next.players.find((p) => p.role === 'btn').id;
    assert.notEqual(newBtn, oldBtn, '庄家应移动');
    assert.deepEqual(next.players.map((p) => p.chips + p.bet), chipsAfter, '新一手只扣盲注，不丢筹码');
    return { n, oldBtn, newBtn, chipsAfter };
  });
}

// ---------------------------------------------------------------------------
// F. 三人不等额全下：主池/边池分配与筹码守恒（与现有单测不同的独立复算）
// ---------------------------------------------------------------------------
check('边池/三人 100·300·300：分配 300/400、筹码守恒、展示侧池正确', () => {
  const t = makeTable(3);
  t.__setNextButton(1);
  t.__setChips(1, 100);
  t.__setChips(2, 300);
  t.__setChips(3, 300);
  t.__setNextDeal({
    handPokes: [
      ['sk', 'hk'], // 2 → KKK
      ['sq', 'hq'], // 3 → QQQ
      ['ca', 'da'], // 1 → AAA
    ],
    commonPokes: ['ha', 'ck', 'dq', 's2', 'h3'],
  });
  t.startHand();
  for (const id of [1, 2, 3]) t.act(id, { type: 'AllIn' });
  const st = t.getState(1);
  assert.equal(st.result.outcome, 'showdown');
  const awards = Object.fromEntries(st.result.awards.map((a) => [a.userId, a.amount]));
  assert.deepEqual(awards, { 1: 300, 2: 400 });
  assert.equal(st.players.reduce((s, p) => s + p.chips, 0), 700);
  assert.deepEqual(st.pot.sidePots.map((p) => p.amount), [300, 400]);
  assert.deepEqual(st.pot.sidePots.map((p) => p.label), ['主池', '边池 1']);
  return { awards, sidePots: st.pot.sidePots, chips: st.players.map((p) => [p.id, p.chips]) };
});

// ---------------------------------------------------------------------------
// G. 四人不等额全下（50/100/200/300）：独立复算预期 200/150/200/100
// ---------------------------------------------------------------------------
check('边池/四人 50·100·200·300：主池+3 边池分别结算、筹码守恒', () => {
  const t = makeTable(4);
  t.__setNextButton(1); // 4 人：行动顺序 2(SB),3(BB),4(UTG),1(BTN)
  t.__setChips(1, 300);
  t.__setChips(2, 50);
  t.__setChips(3, 100);
  t.__setChips(4, 200);
  t.__setNextDeal({
    handPokes: [
      ['sa', 'ha'], // 2 → AA（短码，赢主池）
      ['sk', 'hk'], // 3 → KK（赢 level-100 边池）
      ['sq', 'hq'], // 4 → QQ（赢 level-200 边池）
      ['sj', 'hj'], // 1 → JJ（只拿回未跟注的 100）
    ],
    commonPokes: ['c2', 'd7', 's9', 'ct', 'd3'],
  });
  t.startHand();
  // 4 人桌翻前由 UTG(4) 先行动；统一按当前行动者全下，避免依赖座位顺序假设。
  let guard = 0;
  while (t.controllerStatus === 'in_hand' && guard < 20) {
    t.act(t.getState(1).activePlayerId, { type: 'AllIn' });
    guard += 1;
  }
  const st = t.getState(1);
  assert.equal(st.result.outcome, 'showdown');
  const awards = Object.fromEntries(st.result.awards.map((a) => [a.userId, a.amount]));
  assert.deepEqual(awards, { 2: 200, 3: 150, 4: 200, 1: 100 });
  assert.equal(st.result.potTotal, 650);
  assert.equal(st.result.awards.reduce((s, a) => s + a.amount, 0), 650);
  assert.equal(st.players.reduce((s, p) => s + p.chips, 0), 650);
  // 独立复算展示侧池
  const shown = st.pot.sidePots;
  assert.deepEqual(shown.map((p) => p.amount), [200, 150, 200, 100]);
  const contributions = st.pot.contributions;
  const recomputed = computeSidePots(contributions, st.players.filter((p) => p.seated && p.status !== 'out').map((p) => p.id));
  assert.deepEqual(recomputed.map((p) => p.amount), [200, 150, 200, 100]);
  return { awards, sidePots: shown.map((p) => ({ amount: p.amount, eligible: p.eligible })), recomputed: recomputed.map((p) => p.amount) };
});

// ---------------------------------------------------------------------------
// H. 二人平分底池（公共牌皇家同花顺）：各拿回 20，筹码守恒
// ---------------------------------------------------------------------------
check('平分底池/二人：公共牌皇家同花顺，各 +20，筹码守恒', () => {
  const t = makeTable(2);
  t.__setNextButton(1);
  t.__setNextDeal({
    handPokes: [
      ['c2', 'd3'], // 2
      ['s4', 'h5'], // 1
    ],
    commonPokes: ['ha', 'hk', 'hq', 'hj', 'ht'],
  });
  t.startHand();
  playPassiveToEnd(t);
  const st = t.getState(1);
  assert.equal(st.result.outcome, 'showdown');
  assert.equal(st.result.potTotal, 40, 'SB 跟注 10 + BB 20 + SB 补 10 = 40');
  const awards = st.result.awards;
  assert.equal(awards.reduce((s, a) => s + a.amount, 0), 40);
  const byUser = Object.fromEntries(awards.map((a) => [a.userId, a.amount]));
  assert.equal(byUser[1], 20);
  assert.equal(byUser[2], 20);
  assert.deepEqual(st.players.map((p) => p.chips), [1000, 1000]);
  return { awards, chips: st.players.map((p) => p.chips), board: st.board };
});

// ---------------------------------------------------------------------------
// I. 全下跑马：二人翻前全下，自动发完 5 张公共牌并摊牌，筹码守恒
// ---------------------------------------------------------------------------
check('全下跑马/二人：翻前全下自动跑完 5 张公共牌并结算，筹码守恒', () => {
  const t = makeTable(2);
  t.__setNextButton(1);
  t.__setNextDeal({
    handPokes: [
      ['sa', 'ha'], // 2
      ['sk', 'hk'], // 1
    ],
    commonPokes: ['c2', 'd7', 's9', 'ct', 'dj'],
  });
  t.startHand();
  // 单挑翻前：按钮位全下后 BB 仍需跟注/全下，两家都全下才会触发跑马。
  let guard = 0;
  while (t.controllerStatus === 'in_hand' && guard < 10) {
    t.act(t.getState(1).activePlayerId, { type: 'AllIn' });
    guard += 1;
  }
  const st = t.getState(1);
  assert.equal(t.controllerStatus, 'between_hands');
  assert.equal(st.result.outcome, 'showdown');
  assert.equal(st.board.length, 5);
  assert.equal(st.result.potTotal, 2000);
  assert.equal(st.result.awards.reduce((s, a) => s + a.amount, 0), 2000);
  assert.equal(st.players.reduce((s, p) => s + p.chips, 0), 2000);
  return { board: st.board, awards: st.result.awards, chips: st.players.map((p) => [p.id, p.chips]) };
});

// ---------------------------------------------------------------------------
// J. 多手筹码守恒 + 庄家连续移动
// ---------------------------------------------------------------------------
check('多手/三人：连续 5 手庄家每手移动且筹码守恒', () => {
  const t = makeTable(3);
  const buttons = [];
  for (let hand = 1; hand <= 5; hand += 1) {
    const st = t.startHand();
    assert.equal(st.handNo, hand);
    buttons.push(st.players.find((p) => p.role === 'btn').id);
    playPassiveToEnd(t);
    assert.equal(t.getState(1).players.reduce((s, p) => s + p.chips, 0), 3000);
  }
  for (let i = 1; i < buttons.length; i += 1) assert.notEqual(buttons[i], buttons[i - 1], `第 ${i + 1} 手庄家未移动`);
  return { buttons };
});

const failed = checks.filter((c) => !c.ok);
const report = {
  generatedAt: new Date().toISOString(),
  node: process.version,
  checks,
  summary: { total: checks.length, passed: checks.length - failed.length, failed: failed.length },
};
writeFileSync(path.join(artifacts, 'privacy-rules-audit.json'), JSON.stringify(report, null, 2));
console.log(`\n结果: ${report.summary.passed}/${report.summary.total} 通过, ${failed.length} 失败`);
process.exitCode = failed.length ? 1 : 0;
