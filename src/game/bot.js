import core from 'texas-poker-core';

const { getBestPokesRankSignature } = core;

const CATEGORY_STRENGTH = {
  q: 0.12, // 高牌
  r: 0.28, // 一对
  s: 0.45, // 两对
  t: 0.62, // 三条
  u: 0.75, // 顺子
  v: 0.84, // 同花
  w: 0.92, // 葫芦
  x: 0.97, // 四条
  y: 0.995, // 同花顺
  z: 1, // 皇家同花顺
};

const RANK_VALUE = {
  2: 2, 3: 3, 4: 4, 5: 5, 6: 6, 7: 7, 8: 8, 9: 9,
  t: 10, j: 11, q: 12, k: 13, a: 14,
};

function clamp(n, min, max) {
  return Math.max(min, Math.min(max, n));
}

function preflopStrength(cards) {
  if (!Array.isArray(cards) || cards.length !== 2) return 0.3;
  const ranks = cards.map((c) => String(c)[1]);
  const values = ranks.map((r) => RANK_VALUE[r] || 0).sort((a, b) => b - a);
  const suited = String(cards[0])[0] === String(cards[1])[0];
  const pair = ranks[0] === ranks[1];
  const gap = Math.abs(values[0] - values[1]);
  let strength = 0.2 + (values[0] - 2) * 0.012 + (values[1] - 2) * 0.006;
  if (pair) strength += 0.18 + values[0] * 0.012;
  if (suited) strength += 0.04;
  if (gap === 1) strength += 0.03;
  if (gap > 4) strength -= 0.04;
  return clamp(strength, 0.08, 0.72);
}

/**
 * 粗略牌力估计，只用于机器人决策，不参与正式结算。
 * 摊牌/底池分配始终由 texas-poker-core 的 PotAwarded 决定。
 */
export function estimateBotStrength(state) {
  const cards = state?.you?.cards || [];
  const board = state?.board || [];
  if (!cards.length) return 0.2;
  if (board.length < 3) return preflopStrength(cards);
  try {
    const signature = getBestPokesRankSignature([cards], board);
    const category = String(signature || 'q')[0];
    return CATEGORY_STRENGTH[category] ?? 0.12;
  } catch {
    return 0.25;
  }
}

function chooseBetAmount(a, bigBlind, rng) {
  const min = Math.max(1, Math.floor(a.minTo || bigBlind || 1));
  const max = Math.max(min, Math.floor(a.maxTo || min));
  if (max <= min) return max;
  // 以最小下注为主，偶尔加到 1.5–2 倍盲注，避免每手都打最小注。
  const extra = rng() < 0.35 ? Math.max(1, Math.floor((bigBlind || 2) * 0.5)) : 0;
  return clamp(min + extra, min, max);
}

function raiseAction(a, bigBlind, rng) {
  if (!a.canRaise) return null;
  const target = chooseBetAmount(a, bigBlind, rng);
  const additional = target - Math.floor(a.selfBet || 0);
  if (!Number.isFinite(additional) || additional <= 0) return null;
  if (target >= Math.floor(a.maxTo || 0) && a.canAllIn) return { type: 'AllIn' };
  return { type: 'Raise', additionalAmount: Math.floor(additional) };
}

function betAction(a, bigBlind, rng) {
  if (!a.canBet) return null;
  const target = chooseBetAmount(a, bigBlind, rng);
  if (target >= Math.floor(a.maxTo || 0) && a.canAllIn) return { type: 'AllIn' };
  return { type: 'Bet', amount: Math.floor(target) };
}

/**
 * 根据房主侧 state（bot 自己的视角）选择一个合法行动。
 * 返回值是 HostSession 可直接交给 PokerTable.act 的命令。
 */
export function chooseBotAction(state, rng = Math.random) {
  const a = state?.you?.allowed;
  if (!a || !Array.isArray(a.types) || a.types.length === 0) return null;

  const bigBlind = Number(state.bigBlind || 20);
  const chips = Number(state.you.chips || 0);
  const toCall = Number(a.toCall || 0);
  const strength = clamp(estimateBotStrength(state) + (rng() - 0.5) * 0.14, 0.02, 1);
  const roll = rng();

  if (a.canCheck) {
    if (a.canBet && strength > 0.56 && roll < 0.55) return betAction(a, bigBlind, rng) || { type: 'Check' };
    if (a.canBet && strength > 0.4 && roll < 0.22) return betAction(a, bigBlind, rng) || { type: 'Check' };
    return { type: 'Check' };
  }

  if (a.canAllIn && strength > 0.84 && roll < 0.16) return { type: 'AllIn' };

  if (a.canRaise && strength > 0.58 && roll < 0.55) {
    const action = raiseAction(a, bigBlind, rng);
    if (action) return action;
  }

  if (a.canCall) {
    const priceRatio = toCall / Math.max(1, chips);
    if (strength > 0.52 || toCall <= bigBlind * 2 || priceRatio < 0.14 || roll < 0.16) {
      return { type: 'Call' };
    }
  }

  if (a.canFold) return { type: 'Fold' };
  if (a.canCheck) return { type: 'Check' };
  if (a.canCall) return { type: 'Call' };
  return null;
}
