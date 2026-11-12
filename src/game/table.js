import core from 'texas-poker-core';

const { Texas } = core;

export const MAX_PLAYERS = 6;
export const BIG_BLIND = 20;
export const INITIAL_CHIPS = 1000;
export const ROOM_CODE_ALPHABET = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';

export const STAGE_LABEL = {
  pre_flop: '翻牌前',
  flop: '翻牌',
  turn: '转牌',
  river: '河牌',
};

export const ROLE_LABEL = {
  btn: '庄家',
  sb: '小盲',
  bb: '大盲',
  utg: '枪口',
  utg1: '枪口+1',
  utg2: '枪口+2',
  mp: '中位',
  lj: 'Lojack',
  hj: '劫持位',
  co: '关煞位',
};

export const ACTION_LABEL = {
  fold: '弃牌',
  check: '过牌',
  call: '跟注',
  bet: '下注',
  raise: '加注',
  allIn: '全下',
};

export const RANK_CATEGORY_LABEL = {
  q: '高牌',
  r: '一对',
  s: '两对',
  t: '三条',
  u: '顺子',
  v: '同花',
  w: '葫芦',
  x: '四条',
  y: '同花顺',
  z: '皇家同花顺',
};

const RANK_TEXT = {
  '2': '2',
  '3': '3',
  '4': '4',
  '5': '5',
  '6': '6',
  '7': '7',
  '8': '8',
  '9': '9',
  t: '10',
  j: 'J',
  q: 'Q',
  k: 'K',
  a: 'A',
};

const SUIT_TEXT = { h: '♥', s: '♠', d: '♦', c: '♣' };

const BOT_NAMES = ['机器人·小安', '机器人·小北', '机器人·小西', '机器人·小南', '机器人·小乐', '机器人·小智'];

export function cardText(card) {
  if (typeof card !== 'string' || card.length < 2) return { rank: '?', suit: '?', red: false };
  const suit = card[0];
  const rank = card.slice(1);
  return {
    rank: RANK_TEXT[rank] || rank.toUpperCase(),
    suit: SUIT_TEXT[suit] || suit,
    red: suit === 'h' || suit === 'd',
  };
}

export function formatCards(cards) {
  return (cards || []).map((c) => {
    const t = cardText(c);
    return `${t.rank}${t.suit}`;
  }).join(' ');
}

export function makeRoomCode(length = 6) {
  const bytes = new Uint8Array(length);
  if (globalThis.crypto?.getRandomValues) {
    globalThis.crypto.getRandomValues(bytes);
  } else {
    for (let i = 0; i < length; i += 1) bytes[i] = Math.floor(Math.random() * 256);
  }
  let out = '';
  for (let i = 0; i < length; i += 1) out += ROOM_CODE_ALPHABET[bytes[i] % ROOM_CODE_ALPHABET.length];
  return out;
}

export function randomToken() {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID().replace(/-/g, '');
  const bytes = new Uint8Array(16);
  if (globalThis.crypto?.getRandomValues) globalThis.crypto.getRandomValues(bytes);
  else for (let i = 0; i < bytes.length; i += 1) bytes[i] = Math.floor(Math.random() * 256);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * 从每位玩家的总投入推导主池/边池，仅用于展示。
 * 分配结果始终以 texas-poker-core 的 PotAwarded 为准。
 */
export function computeSidePots(contributions, eligibleIds = null) {
  const items = (contributions || [])
    .filter((c) => Number.isFinite(c.amount) && c.amount > 0)
    .map((c) => ({ userId: c.userId, amount: Math.floor(c.amount) }))
    .sort((a, b) => a.amount - b.amount);
  if (!items.length) return [];
  const eligibleSet = eligibleIds ? new Set(eligibleIds) : null;
  const levels = [...new Set(items.map((i) => i.amount))].sort((a, b) => a - b);
  const pots = [];
  let previous = 0;
  for (const level of levels) {
    const contributors = items.filter((i) => i.amount >= level);
    const eligible = contributors
      .filter((i) => !eligibleSet || eligibleSet.has(i.userId))
      .map((i) => i.userId);
    const amount = (level - previous) * contributors.length;
    if (amount > 0) {
      pots.push({
        amount,
        eligible,
        label: pots.length === 0 ? '主池' : `边池 ${pots.length}`,
      });
    }
    previous = level;
  }
  return pots;
}

function cloneSnapshot(snapshot) {
  return {
    handPokes: snapshot.handPokes.map((h) => [...h]),
    commonPokes: [...snapshot.commonPokes],
  };
}

function toInt(value) {
  const n = Number(value);
  return Number.isFinite(n) ? Math.floor(n) : NaN;
}

export class PokerTable {
  constructor(options = {}) {
    this.hostId = 1;
    this.hostName = String(options.hostName || '房主').slice(0, 16) || '房主';
    this.roomCode = options.roomCode || makeRoomCode();
    this.maxPlayers = Math.min(MAX_PLAYERS, Math.max(2, options.maxPlayers || MAX_PLAYERS));
    this.initialChips = Math.max(1, options.initialChips || INITIAL_CHIPS);
    this.bigBlind = Math.max(2, options.bigBlind || BIG_BLIND);

    this.texas = new Texas({
      user: { id: this.hostId, name: this.hostName },
      lowestBetAmount: this.bigBlind,
      maximumCountOfPlayers: this.maxPlayers,
      initialChips: this.initialChips,
    });
    this.texas.room.seatById(this.hostId);

    this.meta = new Map();
    this.meta.set(this.hostId, {
      id: this.hostId,
      name: this.hostName,
      token: 'host',
      connected: true,
      isHost: true,
      pendingSeat: false,
      joinOrder: 0,
    });
    this.nextJoinOrder = 1;
    this.handNo = 0;
    this.handResult = null;
    this.settled = false;
    this.revealedIds = new Set();
    this.log = [];
    this.logSeq = 0;
    this.lastActionAt = Date.now();
    this.lastError = null;
    this._dealOverride = null;
    this._nextButtonId = null;
    this._lastEventTypes = [];
  }

  get controllerStatus() {
    return this.texas.controller.status;
  }

  get roomStatus() {
    return this.texas.room.status;
  }

  _playerName(id) {
    return this.meta.get(id)?.name || this.texas.room.getPlayerById(id)?.getUserInfo().name || `玩家${id}`;
  }

  _appendLog(text) {
    this.logSeq += 1;
    this.log.push({ seq: this.logSeq, text });
    if (this.log.length > 80) this.log.splice(0, this.log.length - 80);
  }

  _seatedPlayers() {
    return this.texas.room.getPlayersBySeatStatus('on-set');
  }

  _safeReArrange() {
    if (this.texas.dealer.button) this.texas.reArrangeRoles();
  }

  _seatPending() {
    if (this.texas.room.status !== 'seats_open') return;
    for (const meta of this.meta.values()) {
      if (meta.pendingSeat && this.texas.room.has(meta.id)) {
        try {
          this.texas.room.seatById(meta.id);
          meta.pendingSeat = false;
          this._appendLog(`${meta.name} 入座`);
        } catch {
          /* 位置不足或状态变化，下一手再试 */
        }
      }
    }
    this._safeReArrange();
  }

  _unseatBrokePlayers() {
    if (this.texas.room.status !== 'seats_open') return;
    let changed = false;
    for (const p of this._seatedPlayers()) {
      if (p.balance <= 0) {
        try {
          this.texas.room.watchById(p.id);
          const meta = this.meta.get(p.id);
          if (meta) meta.pendingSeat = false;
          this._appendLog(`${this._playerName(p.id)} 筹码耗尽，暂时离座`);
          changed = true;
        } catch {
          /* 状态已变 */
        }
      }
    }
    if (changed) this._safeReArrange();
  }

  addPlayer({ name, token, connected = true } = {}) {
    const cleanName = String(name || '').trim().slice(0, 16);
    const existing = token ? [...this.meta.values()].find((m) => m.token === token) : null;
    if (existing) {
      existing.connected = Boolean(connected);
      if (existing.pendingSeat && this.roomStatus === 'seats_open') this._seatPending();
      return { playerId: existing.id, token: existing.token, name: existing.name, isNew: false };
    }

    if (this.texas.room.getMemberCounts().total >= this.maxPlayers) {
      throw new Error('房间已满');
    }
    let id = 0;
    for (let candidate = 2; candidate <= this.maxPlayers; candidate += 1) {
      if (!this.meta.has(candidate)) {
        id = candidate;
        break;
      }
    }
    if (!id) throw new Error('房间已满');

    const finalName = cleanName || `玩家${id}`;
    const player = this.texas.createPlayer({ id, name: finalName });
    this.texas.room.join(player);
    const meta = {
      id,
      name: finalName,
      token: token || randomToken(),
      connected: Boolean(connected),
      isHost: false,
      isBot: false,
      pendingSeat: false,
      joinOrder: this.nextJoinOrder++,
    };
    this.meta.set(id, meta);

    if (this.roomStatus === 'seats_open') {
      try {
        this.texas.room.seatById(id);
        this._safeReArrange();
      } catch {
        meta.pendingSeat = true;
      }
    } else {
      meta.pendingSeat = true;
    }
    this._appendLog(`${finalName} 加入了房间${meta.pendingSeat ? '（下一手入座）' : ''}`);
    return { playerId: id, token: meta.token, name: meta.name, isNew: true };
  }

  setConnected(playerId, connected) {
    const meta = this.meta.get(playerId);
    if (!meta) return;
    meta.connected = Boolean(connected);
  }

  getPlayerIdByToken(token) {
    return [...this.meta.values()].find((m) => m.token === token)?.id || null;
  }

  getActivePlayerId() {
    return this.texas.controller.status === 'in_hand'
      ? this.texas.controller.activePlayer?.id ?? null
      : null;
  }

  isBot(playerId) {
    return Boolean(this.meta.get(Number(playerId))?.isBot);
  }

  addBot(name = '') {
    if (this.texas.room.getMemberCounts().total >= this.maxPlayers) {
      throw new Error('房间已满');
    }
    let id = 0;
    for (let candidate = 2; candidate <= this.maxPlayers; candidate += 1) {
      if (!this.meta.has(candidate)) {
        id = candidate;
        break;
      }
    }
    if (!id) throw new Error('房间已满');

    const usedNames = new Set([...this.meta.values()].map((m) => m.name));
    const finalName = String(name || '').trim().slice(0, 16)
      || BOT_NAMES.find((n) => !usedNames.has(n))
      || `机器人${id}`;
    const player = this.texas.createPlayer({ id, name: finalName });
    this.texas.room.join(player);
    const meta = {
      id,
      name: finalName,
      token: `bot:${id}:${randomToken()}`,
      connected: true,
      isHost: false,
      isBot: true,
      pendingSeat: false,
      joinOrder: this.nextJoinOrder++,
    };
    this.meta.set(id, meta);

    if (this.roomStatus === 'seats_open') {
      try {
        this.texas.room.seatById(id);
        this._safeReArrange();
      } catch {
        meta.pendingSeat = true;
      }
    } else {
      meta.pendingSeat = true;
    }
    this._appendLog(`${finalName} 加入了房间`);
    return { playerId: id, name: meta.name, isBot: true };
  }

  /** 单机模式兜底：人数不足时补机器人；机器人破产自动补码，避免单人局卡住。 */
  ensureBots(minSeated = 2) {
    for (const meta of this.meta.values()) {
      if (!meta.isBot) continue;
      const p = this.texas.room.getPlayerById(meta.id);
      if (!p) continue;
      if (p.balance <= 0) {
        p.balance = this.initialChips;
        if (this.texas.room.getPlayerSeatStatus(p) === 'hang') meta.pendingSeat = true;
        this._appendLog(`${meta.name} 补码 ${this.initialChips}`);
      }
    }
    let guard = 0;
    while (this.texas.room.getMemberCounts().total < minSeated && guard < this.maxPlayers) {
      this.addBot();
      guard += 1;
    }
    return this.texas.room.getMemberCounts().total;
  }

  _prepareHand() {
    const t = this.texas;
    if (t.controller.status !== 'idle') throw new Error('当前手牌尚未结束');
    if (t.controller.currentHandId === null && this.handNo === 0) {
      const buttonUserId = this._nextButtonId || undefined;
      this._nextButtonId = null;
      t.setPlayerRoles('initial', buttonUserId ? { buttonUserId } : undefined);
      return;
    }
    t.rotateRolesForNewHand();
    t.lockSeats();
    t.setPlayerRoles('rearrange');
  }

  startHand() {
    const t = this.texas;
    if (t.controller.status === 'in_hand') throw new Error('本手仍在进行中');
    // 上一手已结束：先 reset 解锁座位，让等待中的玩家能在本手开始前入座。
    if (t.controller.status === 'between_hands') t.reset();
    if (t.controller.status !== 'idle') throw new Error('当前手牌尚未结束');

    this.handResult = null;
    this.settled = false;
    this.revealedIds.clear();
    this.log = [];
    this.logSeq = 0;
    this._lastEventTypes = [];

    this._seatPending();
    this._unseatBrokePlayers();

    if (t.room.getPlayersBySeatStatus('on-set').length < 2) throw new Error('至少需要 2 名已入座玩家');
    if (t.room.getPlayersBySeatStatus('on-set').some((p) => p.balance <= 0)) {
      throw new Error('有玩家筹码为 0，无法开始');
    }

    const originalDeal = t.dealer.deck.dealCards;
    if (this._dealOverride) {
      const snapshot = cloneSnapshot(this._dealOverride);
      t.dealer.deck.dealCards = () => cloneSnapshot(snapshot);
      this._dealOverride = null;
    }

    let events = [];
    try {
      this._prepareHand();
      const dealEvents = t.dealCards();
      const startEvents = t.start();
      const flowEvents = this.flushAllPendingFlowOps();
      events = [...dealEvents, ...startEvents, ...flowEvents];
    } finally {
      t.dealer.deck.dealCards = originalDeal;
    }

    this.handNo += 1;
    this._appendLog(`第 ${this.handNo} 手开始`);
    this._consume(events);
    return this.getState(this.hostId);
  }

  flushAllPendingFlowOps() {
    return this.texas.flushAllPendingFlowOps();
  }

  _consume(events) {
    for (const event of events || []) {
      this._lastEventTypes.push(event.type);
      this._logEvent(event);
      if (event.type === 'HandEnded') this._handleHandEnded(event);
      if (event.type === 'PotAwarded' && this.handResult) {
        this.handResult.potTotal = event.payload.potTotal;
        this.handResult.awards = event.payload.allocations || [];
        for (const award of this.handResult.awards) {
          this._appendLog(`${this._playerName(award.userId)} 赢得 ${award.amount}`);
        }
      }
    }
  }

  _handleHandEnded(event) {
    const t = this.texas;
    const p = event.payload;
    const reveal = p.outcome === 'showdown';
    this.revealedIds = reveal
      ? new Set(t.dealer.players.filter((pl) => pl.getStatus() !== 'out').map((pl) => pl.id))
      : new Set();
    this.handResult = {
      outcome: p.outcome,
      board: p.pokesRevealed || [],
      endStage: p.endStage,
      bestPokes: p.bestPokes || [],
      bestRankCategory: p.bestRankCategory || null,
      bestRankSignature: p.bestRankSignature || null,
      potTotal: t.pool.totalAmount,
      awards: [],
      revealed: [...this.revealedIds],
    };
    this._appendLog(p.outcome === 'showdown' ? '摊牌' : '其余玩家弃牌');

    if (!this.settled) {
      this.settled = true;
      try {
        const awards = t.settle();
        this._consume(awards);
      } catch (err) {
        this.lastError = err?.message || String(err);
        this._appendLog(`结算失败：${this.lastError}`);
      }
    }
  }

  _logEvent(event) {
    const p = event.payload || {};
    switch (event.type) {
      case 'HandStarted':
        break;
      case 'BlindsPosted':
        for (const post of p.posts || []) {
          this._appendLog(`${this._playerName(post.userId)} ${post.kind === 'sb' ? '小盲' : '大盲'} ${post.amount}`);
        }
        break;
      case 'PostedJoiningBigBlinds':
        for (const post of p.posts || []) {
          this._appendLog(`${this._playerName(post.userId)} 补入座大盲 ${post.amount}`);
        }
        break;
      case 'PlayerActed': {
        const label = ACTION_LABEL[p.actionType] || p.actionType;
        const amount = p.amount ? ` ${p.amount}` : '';
        this._appendLog(`${this._playerName(p.userId)} ${label}${amount}`);
        break;
      }
      case 'StageAdvanced': {
        if (p.toStage === 'flop') this._appendLog(`翻牌：${formatCards(p.pokesRevealedThisStep)}`);
        else if (p.toStage === 'turn') this._appendLog(`转牌：${formatCards(p.pokesRevealedThisStep)}`);
        else if (p.toStage === 'river') this._appendLog(`河牌：${formatCards(p.pokesRevealedThisStep)}`);
        break;
      }
      case 'RunoutHandsRevealed':
        this._appendLog('全员全下，亮牌跑马');
        break;
      case 'RolesAssigned':
      case 'HoleCardsDealt':
        break;
      default:
        break;
    }
  }

  _allowedFor(player) {
    const types = player.getAllowedActions();
    const maxOthers = player.getMaxOthersStageBet();
    const selfBet = player.currentStageTotalAmount;
    const toCall = Math.max(0, maxOthers - selfBet);
    const maxTo = selfBet + player.balance;
    let minTo = null;
    if (types.includes('bet')) minTo = Math.min(maxTo, this.bigBlind);
    if (types.includes('raise')) minTo = Math.min(maxTo, maxOthers + this.bigBlind);
    return {
      types,
      toCall,
      minTo,
      maxTo,
      canCheck: types.includes('check'),
      canCall: types.includes('call'),
      canFold: types.includes('fold'),
      canAllIn: types.includes('allIn'),
      canBet: types.includes('bet'),
      canRaise: types.includes('raise'),
      selfBet,
      maxOthers,
    };
  }

  act(playerId, action) {
    const t = this.texas;
    if (t.controller.status !== 'in_hand') throw new Error('当前没有进行中的手牌');
    const active = t.controller.activePlayer;
    if (!active) throw new Error('当前没有待行动玩家');
    if (active.id !== playerId) throw new Error('还没轮到你行动');

    const type = String(action?.type || '');
    if (!['Fold', 'Check', 'Call', 'Bet', 'Raise', 'AllIn'].includes(type)) {
      throw new Error('未知操作');
    }
    const allowed = active.getAllowedActions();
    const allowedLower = allowed.map((a) => String(a).toLowerCase());
    if (!allowedLower.includes(type.toLowerCase())) {
      throw new Error(`当前不能${ACTION_LABEL[type.toLowerCase() === 'allin' ? 'allIn' : type.toLowerCase()] || type}`);
    }

    const command = { type, playerId };
    if (type === 'Bet') {
      const amount = toInt(action.amount);
      if (!Number.isFinite(amount) || amount <= 0) throw new Error('下注金额无效');
      if (amount > active.balance) throw new Error('下注金额超过筹码');
      if (amount < this.bigBlind && amount < active.balance) throw new Error(`下注至少 ${this.bigBlind}`);
      command.amount = amount;
    }
    if (type === 'Raise') {
      const additional = toInt(action.additionalAmount);
      if (!Number.isFinite(additional) || additional <= 0) throw new Error('加注金额无效');
      if (additional > active.balance) throw new Error('加注金额超过筹码');
      const maxOthers = active.getMaxOthersStageBet();
      const selfBet = active.currentStageTotalAmount;
      if (additional + selfBet <= maxOthers) throw new Error('加注额必须高于当前注');
      if (additional < this.bigBlind && additional < active.balance) {
        throw new Error(`加注至少 ${this.bigBlind}`);
      }
      const callGap = Math.max(0, maxOthers - selfBet);
      const raiseIncrement = additional - callGap;
      if (additional < active.balance && raiseIncrement < this.bigBlind) {
        throw new Error(`最小加注额为 ${callGap + this.bigBlind}`);
      }
      command.additionalAmount = additional;
    }

    let events;
    try {
      events = t.dispatchCommand(command);
      events = [...events, ...t.flushAllPendingFlowOps()];
    } catch (err) {
      this.lastError = err?.message || String(err);
      const wrapped = new Error(this.lastError);
      wrapped.cause = err;
      throw wrapped;
    }
    this._consume(events);
    this.lastActionAt = Date.now();
    return this.getState(playerId);
  }

  rebuy(playerId, amount = this.initialChips) {
    const t = this.texas;
    const p = t.room.getPlayerById(Number(playerId));
    if (!p) throw new Error('玩家不存在');
    if (this.handNo === 0) throw new Error('牌局尚未开始');
    p.balance = Math.max(0, Math.floor(Number(amount) || 0));
    this._appendLog(`${this._playerName(p.id)} 补码 ${p.balance}`);
    if (this.roomStatus === 'seats_open') {
      const meta = this.meta.get(p.id);
      if (meta && t.room.getPlayerSeatStatus(p) === 'hang') {
        try {
          t.room.seatById(p.id);
          meta.pendingSeat = false;
          this._safeReArrange();
        } catch {
          meta.pendingSeat = true;
        }
      }
    }
    return this.getState(this.hostId);
  }

  _viewerHoleCards(player) {
    if (!player) return [];
    try {
      return this.texas.dealer.getHoleCardsForPlayer(player) || [];
    } catch {
      return [];
    }
  }

  getState(viewerId) {
    const t = this.texas;
    const controllerStatus = t.controller.status;
    const inHand = controllerStatus === 'in_hand' || controllerStatus === 'between_hands';
    const seatedIds = new Set(t.room.getPlayersBySeatStatus('on-set').map((p) => p.id));
    const contributions = t.pool.getContributionSnapshot().contributions || [];
    const contribMap = new Map(contributions.map((c) => [c.userId, c.amount]));
    const active = controllerStatus === 'in_hand' ? t.controller.activePlayer : null;
    const showdown = controllerStatus === 'between_hands' && this.handResult?.outcome === 'showdown';

    const players = t.room.getAllPlayers().map((p) => {
      const id = p.id;
      const meta = this.meta.get(id);
      const seated = seatedIds.has(id);
      const hole = inHand && seated ? this._viewerHoleCards(p) : [];
      const reveal = Boolean(showdown && this.revealedIds.has(id));
      return {
        id,
        name: p.getUserInfo().name,
        chips: p.balance,
        seated,
        connected: meta ? meta.connected : false,
        isHost: id === this.hostId,
        isBot: Boolean(meta?.isBot),
        bet: seated ? p.currentStageTotalAmount : 0,
        contributed: contribMap.get(id) || 0,
        status: seated ? p.getStatus() : 'waiting',
        role: p.getRole() || null,
        cards: reveal ? hole : undefined,
        cardCount: seated && inHand ? (hole.length || 2) : 0,
        folded: seated && inHand && p.getStatus() === 'out',
      };
    }).sort((a, b) => a.id - b.id);

    const me = players.find((p) => p.id === viewerId);
    const mePlayer = t.room.getPlayerById(viewerId);
    const viewedHole = mePlayer && seatedIds.has(viewerId) && inHand ? this._viewerHoleCards(mePlayer) : [];
    const allowed = active && active.id === viewerId ? this._allowedFor(active) : null;
    const showdownPots = controllerStatus === 'between_hands' && this.handResult?.outcome === 'showdown'
      ? computeSidePots(contributions, players.filter((p) => p.seated && p.status !== 'out').map((p) => p.id))
      : [];

    return {
      v: 1,
      roomCode: this.roomCode,
      hostId: this.hostId,
      hostName: this.hostName,
      maxPlayers: this.maxPlayers,
      initialChips: this.initialChips,
      bigBlind: this.bigBlind,
      handNo: this.handNo,
      handId: t.controller.currentHandId,
      status: controllerStatus === 'in_hand'
        ? 'playing'
        : controllerStatus === 'between_hands'
          ? 'hand_over'
          : this.handNo === 0
            ? 'lobby'
            : 'idle',
      stage: t.controller.stage,
      stageLabel: STAGE_LABEL[t.controller.stage] || t.controller.stage,
      board: t.controller.getRevealedPokes() || [],
      pot: {
        total: t.pool.totalAmount,
        contributions,
        sidePots: showdownPots,
      },
      players,
      activePlayerId: active ? active.id : null,
      you: {
        id: viewerId,
        name: me?.name || '',
        seated: Boolean(me?.seated),
        cards: viewedHole,
        role: me?.role || null,
        allowed,
        isTurn: Boolean(allowed),
        isHost: viewerId === this.hostId,
        chips: me?.chips || 0,
      },
      result: this.handResult,
      log: this.log.slice(-40),
      serverTime: Date.now(),
    };
  }

  /** 仅测试/调试用：注入下一手固定发牌，用于确定性验收边池。 */
  __setNextDeal(snapshot) {
    if (!snapshot || !Array.isArray(snapshot.handPokes) || !Array.isArray(snapshot.commonPokes)) {
      throw new Error('发牌快照格式错误');
    }
    if (snapshot.commonPokes.length !== 5) throw new Error('公共牌必须是 5 张');
    this._dealOverride = cloneSnapshot(snapshot);
  }

  __setChips(playerId, chips) {
    const p = this.texas.room.getPlayerById(Number(playerId));
    if (!p) throw new Error('玩家不存在');
    p.balance = Math.floor(Number(chips));
  }

  __setNextButton(playerId) {
    this._nextButtonId = Number(playerId);
  }
}
