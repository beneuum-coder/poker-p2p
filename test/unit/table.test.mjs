import test from 'node:test';
import assert from 'node:assert/strict';
import { PokerTable, computeSidePots, cardText, formatCards, RANK_CATEGORY_LABEL } from '../../src/game/table.js';
import { chooseBotAction, chenScore, estimateEquity } from '../../src/game/bot.js';

function threeHanded() {
  const table = new PokerTable({ hostName: '房主', roomCode: 'TEST01' });
  table.addPlayer({ name: '小明' });
  table.addPlayer({ name: '小红' });
  return table;
}

function actUntilIdleOrTurn(table, playerId, strategy = 'passive') {
  const state = table.getState(playerId);
  assert.equal(state.activePlayerId, playerId, `应轮到玩家 ${playerId}，实际 ${state.activePlayerId}`);
  const allowed = state.you.allowed;
  assert.ok(allowed, '当前行动玩家应有 allowed');
  if (allowed.types.includes('check')) {
    table.act(playerId, { type: 'Check' });
  } else if (allowed.types.includes('call')) {
    table.act(playerId, { type: 'Call' });
  } else {
    table.act(playerId, { type: 'Fold' });
  }
}

test('创建房间、入座和盲注扣除', () => {
  const table = threeHanded();
  table.__setNextButton(1);
  const lobby = table.getState(1);
  assert.equal(lobby.status, 'lobby');
  assert.equal(lobby.players.length, 3);
  assert.ok(lobby.players.every((p) => p.seated));
  assert.equal(lobby.players.find((p) => p.id === 1).chips, 1000);

  const state = table.startHand();
  assert.equal(state.status, 'playing');
  assert.equal(state.handNo, 1);
  assert.equal(state.pot.total, 30);
  assert.equal(state.players.reduce((s, p) => s + p.chips, 0) + state.pot.total, 3000);

  const roles = state.players.map((p) => p.role).sort();
  assert.deepEqual(roles, ['bb', 'btn', 'sb']);
  const blinds = state.players.filter((p) => p.role === 'sb' || p.role === 'bb');
  assert.equal(blinds.reduce((sum, p) => sum + p.bet, 0), 30);
  assert.ok(state.you.cards.length === 2);
  assert.equal(state.activePlayerId, 1, '三人桌庄家是翻前第一个行动者');
});

test('完整一手牌：四轮下注、摊牌、底池分配', () => {
  const table = threeHanded();
  table.startHand();
  let guard = 0;
  while (table.controllerStatus === 'in_hand' && guard < 60) {
    const state = table.getState(1);
    if (state.activePlayerId !== 1) {
      actUntilIdleOrTurn(table, state.activePlayerId);
    } else {
      actUntilIdleOrTurn(table, 1);
    }
    guard += 1;
  }
  assert.equal(table.controllerStatus, 'between_hands');
  const final = table.getState(1);
  assert.equal(final.status, 'hand_over');
  assert.equal(final.board.length, 5);
  assert.ok(final.result);
  assert.equal(final.result.outcome, 'showdown');
  assert.ok(final.result.awards.length >= 1);
  assert.equal(final.result.potTotal, 60);
  assert.equal(final.result.awards.reduce((s, a) => s + a.amount, 0), 60);
  assert.equal(final.players.reduce((s, p) => s + p.chips, 0), 3000);
  assert.equal(final.pot.sidePots.length, 1);
  assert.equal(final.pot.sidePots[0].amount, 60);
  const revealed = final.players.filter((p) => p.id !== 1);
  assert.ok(revealed.every((p) => p.cards && p.cards.length === 2), '摊牌后应公开未弃牌玩家的底牌');
  assert.ok(RANK_CATEGORY_LABEL[final.result.bestRankCategory], '最佳牌型中文名应存在');
});

test('底牌保密：摊牌前只有自己的底牌可见', () => {
  const table = threeHanded();
  table.startHand();
  const hostView = table.getState(1);
  const guestView = table.getState(2);
  assert.equal(hostView.you.cards.length, 2);
  assert.equal(guestView.you.cards.length, 2);
  assert.notDeepEqual(hostView.you.cards, guestView.you.cards);

  for (const p of guestView.players) {
    if (p.id === 2) continue;
    assert.equal(p.cards, undefined, `摊牌前不应下发玩家 ${p.id} 的底牌`);
  }
  assert.ok(guestView.players.filter((p) => p.id !== 2).every((p) => p.cardCount === 2));

  // 弃牌到只剩一人：不摊牌，也不应公开任何底牌
  let guard = 0;
  while (table.controllerStatus === 'in_hand' && guard < 20) {
    const state = table.getState(1);
    const activeId = state.activePlayerId;
    table.act(activeId, { type: 'Fold' });
    guard += 1;
    if (table.controllerStatus !== 'in_hand') break;
  }
  const over = table.getState(2);
  assert.equal(over.result.outcome, 'fold_win');
  assert.ok(over.players.every((p) => p.cards === undefined), '弃牌结束后不应公开底牌');
});

test('边池：短码全下，主池与边池分别由不同玩家赢得', () => {
  const table = threeHanded();
  table.__setNextButton(1); // 按钮=房主，三人桌行动顺序 [2(SB),3(BB),1(BTN)]
  table.__setChips(1, 100);
  table.__setChips(2, 300);
  table.__setChips(3, 300);
  table.__setNextDeal({
    // 发牌顺序是行动顺序：2,3,1；公共牌 Ah Kc Qd 2s 3h
    handPokes: [
      ['sk', 'hk'], // 玩家2：KKK
      ['sq', 'hq'], // 玩家3：QQQ
      ['ca', 'da'], // 玩家1：AAA
    ],
    commonPokes: ['ha', 'ck', 'dq', 's2', 'h3'],
  });

  table.startHand();
  assert.equal(table.getState(1).activePlayerId, 1);
  table.act(1, { type: 'AllIn' });
  table.act(2, { type: 'AllIn' });
  table.act(3, { type: 'AllIn' });

  const state = table.getState(1);
  assert.equal(table.controllerStatus, 'between_hands');
  assert.equal(state.result.outcome, 'showdown');
  assert.equal(state.result.potTotal, 700);
  const awards = Object.fromEntries(state.result.awards.map((a) => [a.userId, a.amount]));
  assert.deepEqual(awards, { 1: 300, 2: 400 });
  assert.equal(state.players.find((p) => p.id === 1).chips, 300);
  assert.equal(state.players.find((p) => p.id === 2).chips, 400);
  assert.equal(state.players.find((p) => p.id === 3).chips, 0);
  assert.equal(state.players.reduce((s, p) => s + p.chips, 0), 700);

  const sidePots = computeSidePots(state.pot.contributions);
  assert.deepEqual(sidePots.map((p) => p.amount), [300, 400]);
  assert.deepEqual(sidePots[0].eligible.sort(), [1, 2, 3]);
  assert.deepEqual(sidePots[1].eligible.sort(), [2, 3]);
});

test('断线重连：同一 token 恢复原座位与筹码', () => {
  const table = threeHanded();
  const joined = table.addPlayer({ name: '小明' });
  const before = table.getState(joined.playerId);
  const beforeChips = before.you.chips;
  table.setConnected(joined.playerId, false);
  assert.equal(table.getState(1).players.find((p) => p.id === joined.playerId).connected, false);

  const again = table.addPlayer({ name: '小明', token: joined.token });
  assert.equal(again.playerId, joined.playerId);
  assert.equal(again.isNew, false);
  const after = table.getState(joined.playerId);
  assert.equal(after.you.chips, beforeChips);
  assert.equal(after.you.seated, true);
});

test('行动合法性：拒绝越权、越序和非法金额', () => {
  const table = threeHanded();
  table.__setNextButton(1);
  table.startHand();
  assert.throws(() => table.act(2, { type: 'Call' }), /还没轮到你/);
  assert.throws(() => table.act(1, { type: 'Bet', amount: 20 }), /当前不能/);
  assert.throws(() => table.act(1, { type: 'Raise', additionalAmount: 5 }), /加注/);
  table.act(1, { type: 'Call' });
  assert.equal(table.getState(1).activePlayerId, 2);
  assert.throws(() => table.act(1, { type: 'Call' }), /还没轮到/);
});

test('卡牌格式化', () => {
  assert.deepEqual(cardText('ha'), { rank: 'A', suit: '♥', red: true });
  assert.deepEqual(cardText('sk'), { rank: 'K', suit: '♠', red: false });
  assert.equal(formatCards(['ha', 'sk']), 'A♥ K♠');
  assert.equal(RANK_CATEGORY_LABEL.s, '两对');
  assert.equal(RANK_CATEGORY_LABEL.t, '三条');
  assert.equal(RANK_CATEGORY_LABEL.v, '同花');
  assert.equal(RANK_CATEGORY_LABEL.u, '顺子');
});

test('房间上限 6 人，满员后拒绝新玩家', () => {
  const table = new PokerTable({ hostName: '房主' });
  for (let i = 0; i < 5; i += 1) table.addPlayer({ name: `玩家${i + 2}` });
  assert.equal(table.getState(1).players.length, 6);
  assert.throws(() => table.addPlayer({ name: '第七人' }), /房间已满/);
});

test('下一手：重置公共牌、移动庄家、保留筹码', () => {
  const table = threeHanded();
  table.startHand();
  let guard = 0;
  while (table.controllerStatus === 'in_hand' && guard++ < 60) {
    const st = table.getState(1);
    actUntilIdleOrTurn(table, st.activePlayerId);
  }
  const chipsAfter = table.getState(1).players.map((p) => p.chips);
  const oldButton = table.getState(1).players.find((p) => p.role === 'btn').id;
  table.startHand();
  const next = table.getState(1);
  assert.equal(next.handNo, 2);
  assert.equal(next.status, 'playing');
  assert.equal(next.board.length, 0);
  assert.notEqual(next.players.find((p) => p.role === 'btn').id, oldButton);
  assert.deepEqual(
    next.players.map((p) => p.chips + p.bet),
    chipsAfter,
    '新一手只扣除盲注，筹码总额不丢失',
  );
  assert.equal(next.pot.total, 30);
});

test('机器人：单人房自动补位，机器人合法打完一手', () => {
  const table = new PokerTable({ hostName: '单机房主', roomCode: 'BOT001' });
  assert.equal(table.getState(1).players.length, 1);
  table.ensureBots(3);
  const lobby = table.getState(1);
  assert.equal(lobby.players.length, 3);
  assert.equal(lobby.players.filter((p) => p.isBot).length, 2);
  assert.ok(lobby.players.filter((p) => p.isBot).every((p) => p.connected && p.seated));

  table.startHand();
  assert.equal(table.getState(1).players.filter((p) => p.isBot && p.cardCount === 2).length, 2);
  let guard = 0;
  while (table.controllerStatus === 'in_hand' && guard < 200) {
    const activeId = table.getActivePlayerId();
    assert.ok(activeId, '进行中应有行动玩家');
    const state = table.getState(activeId);
    const action = chooseBotAction(state, () => 0.3);
    assert.ok(action, '机器人应给出合法行动');
    assert.doesNotThrow(() => table.act(activeId, action), `机器人动作应合法：${JSON.stringify(action)}`);
    guard += 1;
  }
  assert.equal(table.controllerStatus, 'between_hands');
  const done = table.getState(1);
  assert.ok(done.result);
  assert.equal(done.players.reduce((s, p) => s + p.chips, 0), 3000);
  assert.ok(done.result.awards.length >= 1);
});

test('机器人策略：Chen 翻前分数与蒙特卡洛胜率', () => {
  assert.ok(chenScore(['ha', 'da']) > chenScore(['ha', 'hk']), 'AA 应强于 AKs');
  assert.ok(chenScore(['ha', 'hk']) > chenScore(['h7', 'd2']), 'AKs 应强于 72o');

  const state = {
    you: { id: 1, cards: ['ha', 'da'] },
    board: ['h7', 'd2', 'c9'],
    players: [
      { id: 1, seated: true, status: 'eligible' },
      { id: 2, seated: true, status: 'eligible' },
      { id: 3, seated: true, status: 'eligible' },
    ],
  };
  let seed = 7;
  const rng = () => {
    seed = (seed * 48271) % 2147483647;
    return seed / 2147483647;
  };
  const equity = estimateEquity(state, 60, rng);
  assert.ok(equity > 0.45 && equity < 0.95, `AA 对两个随机对手胜率应合理，实际 ${equity}`);
});

test('机器人等级：低等级更愿意跟注看翻牌，高等级更紧', () => {
  const makeState = (level) => ({
    stage: 'pre_flop',
    bigBlind: 20,
    pot: { total: 60 },
    you: {
      id: 2,
      level,
      role: 'bb',
      chips: 1000,
      cards: ['ha', 'd3'],
      allowed: {
        types: ['call', 'raise', 'allIn', 'fold'],
        toCall: 40,
        minTo: 60,
        maxTo: 1000,
        selfBet: 20,
        maxOthers: 40,
        canCall: true,
        canCheck: false,
        canFold: true,
        canRaise: true,
        canAllIn: true,
        canBet: false,
      },
    },
    players: [
      { id: 1, seated: true, status: 'eligible' },
      { id: 2, seated: true, status: 'eligible' },
    ],
  });
  const low = chooseBotAction(makeState('low'), () => 0.3);
  const high = chooseBotAction(makeState('high'), () => 0.3);
  assert.equal(low.type, 'Call', '低等级应用较宽范围跟注看翻牌');
  assert.equal(high.type, 'Fold', '高等级应更紧地弃掉边缘牌');
});

test('机器人破产自动补码，下一手不会卡住', () => {
  const table = new PokerTable({ hostName: '单机房主', roomCode: 'BOT002' });
  table.ensureBots(2);
  table.startHand();
  let guard = 0;
  while (table.controllerStatus === 'in_hand' && guard < 80) {
    const activeId = table.getActivePlayerId();
    const state = table.getState(activeId);
    table.act(activeId, chooseBotAction(state, () => 0.4) || { type: 'Fold' });
    guard += 1;
  }
  table.__setChips(2, 0);
  table.ensureBots(2);
  assert.equal(table.getState(1).players.find((p) => p.id === 2).chips, 1000);
  table.startHand();
  assert.equal(table.getState(1).status, 'playing');
  const botAfter = table.getState(1).players.find((p) => p.id === 2);
  assert.equal(botAfter.chips + botAfter.bet, 1000, '补码后只扣除盲注');
});
