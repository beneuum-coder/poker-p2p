import core from 'texas-poker-core';

const { getBestPokesRankSignature, getStrengthFromRankSignature } = core;

const SUITS = ['h', 's', 'd', 'c'];
const RANKS = ['2', '3', '4', '5', '6', '7', '8', '9', 't', 'j', 'q', 'k', 'a'];
const FULL_DECK = SUITS.flatMap((suit) => RANKS.map((rank) => suit + rank));

const RANK_VALUE = {
  2: 2, 3: 3, 4: 4, 5: 5, 6: 6, 7: 7, 8: 8, 9: 9,
  t: 10, j: 11, q: 12, k: 13, a: 14,
};

const CHEN_HIGH = {
  14: 10, 13: 8, 12: 7, 11: 6, 10: 5, 9: 4.5, 8: 4, 7: 3.5, 6: 3, 5: 2.5, 4: 2, 3: 1.5, 2: 1,
};

const OPEN_MIN = {
  utg: 8.8, utg1: 8.5, utg2: 8.2, mp: 8.2, lj: 8.0, hj: 7.8, co: 7.4, btn: 6.8, sb: 7.2, bb: 5.8,
};

function clamp(n, min, max) {
  return Math.max(min, Math.min(max, n));
}

function cardRank(card) {
  return RANK_VALUE[String(card)[1]] || 0;
}

function cardSuit(card) {
  return String(card)[0];
}

function isPair(cards) {
  return cards.length === 2 && cardRank(cards[0]) === cardRank(cards[1]);
}

function preflopInfo(cards) {
  const values = cards.map(cardRank).sort((a, b) => b - a);
  const pair = values[0] === values[1];
  const suited = cardSuit(cards[0]) === cardSuit(cards[1]);
  const gap = Math.abs(values[0] - values[1]);
  return { high: values[0], low: values[1], pair, suited, gap };
}

/** Chen formula，作为翻前手牌强度的基线。 */
export function chenScore(cards) {
  if (!Array.isArray(cards) || cards.length !== 2) return 0;
  const info = preflopInfo(cards);
  if (info.pair) return Math.max(5, CHEN_HIGH[info.high] * 2);
  let score = CHEN_HIGH[info.high] || 0;
  if (info.suited) score += 2;
  const gapPenalty = { 0: 0, 1: -1, 2: -2, 3: -4, 4: -5 };
  score += gapPenalty[info.gap] ?? -6;
  if (info.gap <= 1 && info.high < 12 && info.low < 12) score += 1;
  return score;
}

function openThreshold(role, activePlayers) {
  if (activePlayers <= 2) {
    if (role === 'btn' || role === 'sb') return 5.2;
    if (role === 'bb') return 4.6;
    return 5.5;
  }
  return OPEN_MIN[role] ?? 8.5;
}

function continueThreshold(role, activePlayers) {
  if (activePlayers <= 2) return 6.5;
  if (role === 'bb') return 6.2;
  if (role === 'sb') return 7.0;
  if (role === 'btn' || role === 'co') return 7.2;
  return 8.0;
}

function threeBetThreshold(role, activePlayers) {
  if (activePlayers <= 2) return 9.5;
  if (role === 'btn' || role === 'co') return 10.2;
  return 10.8;
}

function raiseSize(state, a, multiplier = 2.8, potFraction = 0) {
  const bb = Number(state.bigBlind || 20);
  const maxOthers = Number(a.maxOthers || 0);
  const maxTo = Math.floor(a.maxTo || 0);
  const minTo = Math.floor(a.minTo || 0);
  let target;
  if (maxOthers > 0) {
    target = Math.round((maxOthers * multiplier + (state.pot?.total || 0) * potFraction) / bb) * bb;
  } else {
    target = Math.round((state.pot?.total || 0) * Math.max(0.5, potFraction) / bb) * bb;
  }
  target = clamp(target, Math.max(minTo, bb), maxTo);
  if (target >= maxTo && a.canAllIn) return { type: 'AllIn' };
  const additional = target - Math.floor(a.selfBet || 0);
  if (!Number.isFinite(additional) || additional <= 0) {
    return a.canCall ? { type: 'Call' } : { type: 'Fold' };
  }
  return { type: 'Raise', additionalAmount: additional };
}

function betSize(state, a, fraction = 0.6) {
  const bb = Number(state.bigBlind || 20);
  const maxTo = Math.floor(a.maxTo || 0);
  const minTo = Math.floor(a.minTo || 0);
  const pot = Number(state.pot?.total || 0);
  let target = Math.round((pot * fraction) / bb) * bb;
  target = clamp(target, Math.max(minTo, bb), maxTo);
  if (target >= maxTo && a.canAllIn) return { type: 'AllIn' };
  return { type: 'Bet', amount: Math.max(1, target) };
}

function drawFrom(deck, count, rng) {
  for (let i = 0; i < count; i += 1) {
    const j = i + Math.floor(rng() * (deck.length - i));
    const tmp = deck[i];
    deck[i] = deck[j];
    deck[j] = tmp;
  }
  return deck.slice(0, count);
}

/**
 * 蒙特卡洛胜率：对每个对手随机发 2 张未知底牌，补完公共牌后比较牌力。
 * 只用于机器人决策；正式结算仍以 texas-poker-core 为准。
 */
export function estimateEquity(state, samples = 60, rng = Math.random) {
  const hole = state?.you?.cards || [];
  const board = state?.board || [];
  if (hole.length !== 2) return 0.5;
  const opponents = (state.players || []).filter((p) => (
    p.id !== state.you.id && p.seated && p.status !== 'out' && p.status !== 'waiting'
  )).length;
  if (opponents === 0) return 1;
  const known = new Set([...hole, ...board]);
  const baseDeck = FULL_DECK.filter((c) => !known.has(c));
  const neededBoard = 5 - board.length;
  let equity = 0;

  for (let i = 0; i < samples; i += 1) {
    const deck = baseDeck.slice();
    const simBoard = [...board, ...drawFrom(deck, neededBoard, rng)];
    const mySignature = getBestPokesRankSignature([hole], simBoard);
    const myStrength = getStrengthFromRankSignature(mySignature);
    let best = myStrength;
    let winners = 1;
    let selfBest = true;
    for (let o = 0; o < opponents; o += 1) {
      const oppHole = drawFrom(deck, 2, rng);
      const signature = getBestPokesRankSignature([oppHole], simBoard);
      const strength = getStrengthFromRankSignature(signature);
      if (strength > best) {
        best = strength;
        winners = 1;
        selfBest = false;
      } else if (strength === best && selfBest) {
        winners += 1;
      } else if (strength === best) {
        winners += 1;
      }
    }
    if (selfBest) equity += 1 / winners;
  }
  return equity / samples;
}

/** 兼容旧接口：翻前返回按 20 分制归一化的强度，翻后返回蒙特卡洛胜率。 */
export function estimateBotStrength(state) {
  const cards = state?.you?.cards || [];
  if ((state?.board?.length || 0) >= 3) return estimateEquity(state, 40);
  return clamp(chenScore(cards) / 20, 0.05, 0.95);
}

function preflopDecision(state, rng) {
  const a = state.you.allowed;
  const cards = state.you.cards || [];
  const role = state.you.role || 'mp';
  const level = ['low', 'medium', 'high'].includes(state.you.level) ? state.you.level : 'medium';
  const levelAdj = {
    low: { open: -2.4, call: -2.4, threeBet: 1.6, raiseChance: 0.32, threeBetChance: 0.14 },
    medium: { open: 0, call: -2.5, threeBet: 0, raiseChance: 0.82, threeBetChance: 0.7 },
    high: { open: 0.8, call: 0.5, threeBet: -0.3, raiseChance: 0.92, threeBetChance: 0.86 },
  }[level];
  const activePlayers = (state.players || []).filter((p) => p.seated && p.status !== 'out' && p.status !== 'waiting').length;
  const bb = Number(state.bigBlind || 20);
  const info = preflopInfo(cards);
  let score = chenScore(cards);
  if (info.pair && ['btn', 'co', 'sb'].includes(role)) score += 1.2;
  if (info.suited && info.gap <= 2) score += 0.6;
  if (info.high >= 11 && info.low >= 10 && info.suited) score += 0.4;

  const openMin = openThreshold(role, activePlayers) + levelAdj.open;
  const facingRaise = Number(a.maxOthers || 0) > bb;
  const toCall = Number(a.toCall || 0);
  const stack = Number(state.you.chips || 0);
  const raisedPot = toCall > 0 && toCall / Math.max(1, stack) > 0.28;

  if (!facingRaise) {
    if (a.canCheck) {
      if (score >= openMin + 1.0 && a.canRaise && rng() < levelAdj.raiseChance) {
        return raiseSize(state, a, 2.6, 0.1);
      }
      return { type: 'Check' };
    }
    if (a.canRaise && score >= openMin && rng() < levelAdj.raiseChance) {
      return raiseSize(state, a, 2.6, 0.1);
    }
    if (a.canCall && (toCall <= bb || score >= openMin - 1.2)) return { type: 'Call' };
    if (a.canFold) return { type: 'Fold' };
  }

  // 面对加注：强牌 3-bet，边缘牌按位置/价格跟注，否则弃牌。
  const threeBetMin = threeBetThreshold(role, activePlayers) + levelAdj.threeBet;
  if (a.canRaise && score >= threeBetMin && rng() < levelAdj.threeBetChance) {
    return raiseSize(state, a, 2.9, 0.1);
  }
  if (a.canAllIn && score >= 12 && stack <= (state.pot?.total || 0) * 0.8 && rng() < 0.55) {
    return { type: 'AllIn' };
  }
  const callMin = continueThreshold(role, activePlayers) + levelAdj.call;
  const priceRatio = toCall / Math.max(1, stack);
  if (a.canCall && score >= callMin && !raisedPot && priceRatio < (level === 'low' ? 0.38 : 0.22)) {
    return { type: 'Call' };
  }
  if (a.canCall && info.pair && toCall <= bb * (level === 'low' ? 8 : 4) && priceRatio < 0.28) {
    return { type: 'Call' };
  }
  const speculative = info.suited && info.gap <= 2;
  const broadway = info.high >= 12 || (info.high >= 10 && info.low >= 9);
  if (a.canCall && level !== 'high' && (speculative || broadway) && priceRatio < 0.22) {
    return { type: 'Call' };
  }
  if (a.canCall && level === 'low' && toCall <= bb * 4 && priceRatio < 0.3) {
    return { type: 'Call' };
  }
  if (a.canCall && score >= callMin + 2 && priceRatio < 0.32) {
    return { type: 'Call' };
  }
  if (a.canFold) return { type: 'Fold' };
  if (a.canCheck) return { type: 'Check' };
  if (a.canCall) return { type: 'Call' };
  return null;
}

function postflopDecision(state, rng) {
  const a = state.you.allowed;
  const level = ['low', 'medium', 'high'].includes(state.you.level) ? state.you.level : 'medium';
  const cfg = {
    low: { callAdj: -0.06, value: 0.82, valueFreq: 0.55, bluff: 0.08, raise: 0.88, size: 0.5 },
    medium: { callAdj: 0.025, value: 0.62, valueFreq: 0.62, bluff: 0.2, raise: 0.78, size: 0.6 },
    high: { callAdj: 0.05, value: 0.68, valueFreq: 0.82, bluff: 0.12, raise: 0.72, size: 0.7 },
  }[level];
  const opponents = (state.players || []).filter((p) => (
    p.id !== state.you.id && p.seated && p.status !== 'out' && p.status !== 'waiting'
  )).length;
  const samples = opponents >= 4 ? 40 : opponents === 3 ? 55 : 80;
  const equity = estimateEquity(state, samples, rng);
  const pot = Number(state.pot?.total || 0);
  const toCall = Number(a.toCall || 0);
  const stack = Number(state.you.chips || 0);
  const potOdds = toCall > 0 ? toCall / Math.max(1, pot + toCall) : 0;
  const river = state.stage === 'river';
  const roll = rng();

  if (a.canCheck) {
    if (a.canBet && equity > cfg.value && roll < cfg.valueFreq) return betSize(state, a, cfg.size);
    if (a.canBet && equity < 0.34 && !river && roll < cfg.bluff) return betSize(state, a, 0.45);
    return { type: 'Check' };
  }

  if (a.canRaise && equity > cfg.raise && roll < 0.72) {
    return raiseSize(state, a, 1.0, 0.7);
  }
  if (a.canAllIn && equity > 0.9 && toCall > 0 && stack <= pot * 0.9 && roll < 0.4) {
    return { type: 'AllIn' };
  }
  if (a.canCall) {
    const required = potOdds + cfg.callAdj;
    if (equity >= required) return { type: 'Call' };
    if (level === 'low' && toCall > 0 && toCall <= pot * 0.35 && equity > 0.22) return { type: 'Call' };
    if (toCall > 0 && toCall <= state.bigBlind && equity > 0.3) return { type: 'Call' };
  }
  if (a.canFold) return { type: 'Fold' };
  if (a.canCheck) return { type: 'Check' };
  if (a.canCall) return { type: 'Call' };
  return null;
}

/**
 * 根据房主侧 state（bot 自己的视角）选择一个合法行动。
 * 翻前用位置 + Chen 分数，翻后用蒙特卡洛胜率 + 底池赔率 + 下注尺度。
 */
export function chooseBotAction(state, rng = Math.random) {
  const a = state?.you?.allowed;
  if (!a || !Array.isArray(a.types) || a.types.length === 0) return null;
  if (state.stage === 'pre_flop') return preflopDecision(state, rng);
  return postflopDecision(state, rng);
}
