import Peer from 'peerjs';
import { chooseBotAction } from '../game/bot.js';

const PEER_PREFIX = 'txp-poker-';

export function peerIdForRoom(roomCode) {
  return `${PEER_PREFIX}${String(roomCode || '').toLowerCase()}`;
}

const PEER_CONFIG = {
  debug: 0,
  config: {
    iceServers: [
      { urls: 'stun:stun.l.google.com:19302' },
      { urls: 'stun:stun1.l.google.com:19302' },
      { urls: 'stun:global.stun.twilio.com:3478' },
    ],
  },
};

function createPeer(id) {
  return id ? new Peer(id, PEER_CONFIG) : new Peer(PEER_CONFIG);
}

/**
 * 房主侧联机层：固定 PeerJS id，接收 DataConnection，按 token 恢复玩家身份。
 * 牌局状态全部由 PokerTable 持有，本类只做传输与会话映射。
 */
export class HostSession {
  constructor({ roomCode, hostName, onHostState, onStatus, onError } = {}) {
    this.roomCode = roomCode;
    this.hostName = hostName || '房主';
    this.onHostState = onHostState || (() => {});
    this.onStatus = onStatus || (() => {});
    this.onError = onError || (() => {});
    this.table = null;
    this.peer = null;
    this.connections = new Map(); // playerId -> conn
    this.pendingConns = new Set();
    this.retryTimer = null;
    this.botTimer = null;
    this.retryDelay = 1000;
    this.destroyed = false;
    this.hasOpened = false;
  }

  init(table) {
    this.table = table;
    this._emitStatus('connecting', '正在连接公共信令服务器…');
    this._createPeer();
  }

  _emitStatus(phase, detail) {
    this.onStatus({ phase, detail });
  }

  _createPeer() {
    if (this.destroyed) return;
    const old = this.peer;
    if (old) {
      try { old.destroy(); } catch { /* ignore */ }
    }
    const peer = createPeer(peerIdForRoom(this.roomCode));
    this.peer = peer;

    peer.on('open', () => {
      if (this.destroyed) return;
      this.hasOpened = true;
      this.retryDelay = 1000;
      this._emitStatus('connected', '房间已上线，等待玩家加入');
      this._broadcast();
    });

    peer.on('connection', (conn) => this._attach(conn));

    peer.on('disconnected', () => {
      if (this.destroyed) return;
      this._emitStatus('reconnecting', '信令连接断开，正在重连…');
      this._scheduleReconnect();
    });

    peer.on('close', () => {
      if (this.destroyed) return;
      this._emitStatus('reconnecting', '信令连接已关闭，正在恢复…');
      this._scheduleReconnect(true);
    });

    peer.on('error', (err) => {
      if (this.destroyed) return;
      const type = err?.type || 'unknown';
      if (type === 'unavailable-id') {
        if (this.hasOpened) {
          this._emitStatus('reconnecting', '信令连接恢复中，正在重试房间…');
          this._scheduleReconnect(true);
          return;
        }
        this._emitStatus('error', '房间码被占用，请返回重新创建房间');
        this.onError('房间码被占用，请返回重新创建房间');
        return;
      }
      if (type === 'peer-unavailable') return;
      if (['network', 'server-error', 'socket-error', 'socket-closed'].includes(type)) {
        this._emitStatus('reconnecting', '信令服务器连接异常，正在重试…');
        this._scheduleReconnect(type === 'network' || type === 'server-error');
        return;
      }
      this.onError(`联机异常：${err?.message || type}`);
    });
  }

  _scheduleReconnect(forceNewPeer = false) {
    if (this.destroyed || this.retryTimer) return;
    const delay = this.retryDelay;
    this.retryDelay = Math.min(this.retryDelay * 1.8, 8000);
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      if (this.destroyed) return;
      const peer = this.peer;
      if (!forceNewPeer && peer && !peer.destroyed) {
        if (peer.disconnected && !peer.open) {
          try { peer.reconnect(); } catch { /* recreate below */ }
        }
        if (peer.open) {
          this._emitStatus('connected', '房间已恢复上线');
          this._broadcast();
          return;
        }
        // 再给 reconnect 一点时间；仍不可用则重建
        setTimeout(() => {
          if (this.destroyed) return;
          if (!this.peer || this.peer.destroyed || !this.peer.open) this._createPeer();
        }, 2000);
        return;
      }
      this._createPeer();
    }, delay);
  }

  _attach(conn) {
    if (this.destroyed) return;
    conn.__playerId = null;
    conn.__helloDone = false;
    this.pendingConns.add(conn);

    conn.on('open', () => {
      this.pendingConns.add(conn);
    });

    conn.on('data', (raw) => {
      let msg;
      try {
        msg = typeof raw === 'string' ? JSON.parse(raw) : raw;
      } catch {
        return;
      }
      if (!msg || typeof msg !== 'object') return;
      this._onMessage(conn, msg);
    });

    const cleanup = () => {
      this.pendingConns.delete(conn);
      if (conn.__playerId != null) {
        const current = this.connections.get(conn.__playerId);
        if (current === conn) {
          this.connections.delete(conn.__playerId);
          this.table?.setConnected(conn.__playerId, false);
          this._emitStatus('connected', '有玩家断开，座位与筹码已保留');
          this._broadcast();
        }
      }
    };
    conn.on('close', cleanup);
    conn.on('error', cleanup);
  }

  _onMessage(conn, msg) {
    const t = msg.t;
    if (t === 'hello') {
      this._handleHello(conn, msg);
      return;
    }
    if (!conn.__playerId) {
      this._send(conn, { t: 'error', message: '请先完成加入握手' });
      return;
    }
    if (t === 'ping') {
      this._send(conn, { t: 'pong', ts: msg.ts });
      return;
    }
    if (t === 'action') {
      try {
        this.table.act(conn.__playerId, msg.action || {});
        this.sync();
      } catch (err) {
        this._send(conn, { t: 'error', message: err?.message || '操作失败' });
      }
    }
  }

  _handleHello(conn, msg) {
    if (conn.__helloDone) return;
    let result;
    try {
      result = this.table.addPlayer({
        name: msg.name,
        token: typeof msg.token === 'string' && msg.token.length >= 8 ? msg.token : undefined,
        connected: true,
      });
    } catch (err) {
      this._send(conn, { t: 'rejected', reason: err?.message || '加入失败' });
      setTimeout(() => { try { conn.close(); } catch { /* ignore */ } }, 300);
      return;
    }
    conn.__helloDone = true;
    conn.__playerId = result.playerId;
    this.pendingConns.delete(conn);

    const previous = this.connections.get(result.playerId);
    if (previous && previous !== conn) {
      try { previous.close(); } catch { /* ignore */ }
    }
    this.connections.set(result.playerId, conn);

    this._send(conn, {
      t: 'welcome',
      playerId: result.playerId,
      token: result.token,
      roomCode: this.roomCode,
      state: this.table.getState(result.playerId),
    });
    this._emitStatus('connected', '房间已上线，等待玩家加入');
    this._broadcast();
    this.onHostState(this.table.getState(1));
  }

  _send(conn, payload) {
    if (!conn || !conn.open) return;
    try {
      conn.send(payload);
    } catch {
      /* 断线由 close/error 事件处理 */
    }
  }

  sendTo(playerId, payload) {
    const conn = this.connections.get(Number(playerId));
    if (!conn) return false;
    this._send(conn, payload);
    return true;
  }

  _broadcast() {
    if (!this.table) return;
    for (const [playerId, conn] of this.connections) {
      this._send(conn, { t: 'state', state: this.table.getState(playerId) });
    }
  }

  notifyHostState() {
    this.onHostState(this.table.getState(1));
  }

  sync() {
    this._broadcast();
    this.notifyHostState();
    this.scheduleBot();
  }

  scheduleBot(delay = 780) {
    if (this.botTimer) {
      clearTimeout(this.botTimer);
      this.botTimer = null;
    }
    if (this.destroyed || !this.table || this.table.controllerStatus !== 'in_hand') return;
    const activeId = this.table.getActivePlayerId();
    if (!activeId || !this.table.isBot(activeId)) return;

    this.botTimer = setTimeout(() => {
      this.botTimer = null;
      if (this.destroyed || !this.table || this.table.controllerStatus !== 'in_hand') return;
      if (this.table.getActivePlayerId() !== activeId) {
        this.scheduleBot();
        return;
      }
      let action = null;
      try {
        const state = this.table.getState(activeId);
        action = chooseBotAction(state);
        if (!action) throw new Error('没有可执行的合法行动');
        this.table.act(activeId, action);
      } catch (err) {
        try {
          const state = this.table.getState(activeId);
          const types = state.you?.allowed?.types || [];
          const fallback = types.includes('check')
            ? { type: 'Check' }
            : types.includes('call')
              ? { type: 'Call' }
              : types.includes('fold')
                ? { type: 'Fold' }
                : null;
          if (!fallback) throw err;
          this.table.act(activeId, fallback);
        } catch (fallbackErr) {
          this.onError(`机器人行动失败：${fallbackErr?.message || fallbackErr}`);
        }
      }
      this.sync();
    }, delay);
  }

  addBot(level = 'medium') {
    const bot = this.table.addBot('', level);
    this.sync();
    return bot;
  }

  fillBots(target = this.table.maxPlayers, level = 'medium') {
    let guard = 0;
    while (this.table.texas.room.getMemberCounts().total < target && guard < this.table.maxPlayers) {
      this.table.addBot('', level);
      guard += 1;
    }
    this.sync();
  }

  removeBot(playerId) {
    this.table.removeBot(playerId);
    this.sync();
  }

  actAsHost(action) {
    this.table.act(1, action);
    this.sync();
  }

  startHand(level = 'medium') {
    this.table.ensureBots(2, level);
    this.table.startHand();
    this.sync();
  }

  rebuy(playerId) {
    this.table.rebuy(playerId);
    this.sync();
  }

  destroy() {
    this.destroyed = true;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    if (this.botTimer) clearTimeout(this.botTimer);
    for (const conn of this.connections.values()) {
      try { conn.close(); } catch { /* ignore */ }
    }
    this.connections.clear();
    try { this.peer?.destroy(); } catch { /* ignore */ }
  }
}

/**
 * 玩家侧联机层：刷新后凭 localStorage 里的 token 重新加入原座位。
 */
export class GuestSession {
  constructor({ roomCode, name, token, onState, onStatus, onError, onWelcome, onRejected } = {}) {
    this.roomCode = roomCode;
    this.name = name;
    this.token = token || null;
    this.onState = onState || (() => {});
    this.onStatus = onStatus || (() => {});
    this.onError = onError || (() => {});
    this.onWelcome = onWelcome || (() => {});
    this.onRejected = onRejected || (() => {});
    this.peer = null;
    this.conn = null;
    this.playerId = null;
    this.connected = false;
    this.destroyed = false;
    this.retryTimer = null;
    this.retryDelay = 900;
    this.lastMessageAt = 0;
    this.heartbeatTimer = null;
    this._connectWatchTimer = null;
  }

  init() {
    this._emitStatus('connecting', '正在连接房间…');
    this._createPeer();
    this.heartbeatTimer = setInterval(() => this._heartbeat(), 15000);
  }

  _emitStatus(phase, detail) {
    this.onStatus({ phase, detail });
  }

  _createPeer() {
    if (this.destroyed) return;
    const old = this.peer;
    if (old) {
      try { old.destroy(); } catch { /* ignore */ }
    }
    const peer = createPeer();
    this.peer = peer;

    peer.on('open', () => {
      if (this.destroyed) return;
      this._connect();
    });

    peer.on('disconnected', () => {
      if (this.destroyed) return;
      this.connected = false;
      this._emitStatus('reconnecting', '与信令服务器断开，正在重连…');
      try { peer.reconnect(); } catch { /* recreate */ }
      this._scheduleReconnect();
    });

    peer.on('close', () => {
      if (this.destroyed) return;
      this.connected = false;
      this._emitStatus('reconnecting', '连接已关闭，正在恢复…');
      this._scheduleReconnect(true);
    });

    peer.on('error', (err) => {
      if (this.destroyed) return;
      const type = err?.type || 'unknown';
      if (type === 'peer-unavailable') {
        this.connected = false;
        this._emitStatus('reconnecting', '找不到房间，正在重试…（房主可能暂时离线）');
        this._cleanupConn();
        this._scheduleReconnect();
        return;
      }
      if (['network', 'server-error', 'socket-error', 'socket-closed'].includes(type)) {
        this._emitStatus('reconnecting', '信令服务器连接异常，正在重试…');
        this._scheduleReconnect(true);
        return;
      }
      this.onError(`联机异常：${err?.message || type}`);
    });
  }

  _connect() {
    if (this.destroyed || !this.peer?.open) return;
    this._cleanupConn();
    this._emitStatus('connecting', '正在加入房间…');
    let conn;
    try {
      conn = this.peer.connect(peerIdForRoom(this.roomCode), { reliable: true });
    } catch {
      this._scheduleReconnect();
      return;
    }
    this.conn = conn;

    conn.on('open', () => {
      if (this.destroyed || this.conn !== conn) return;
      this.connected = true;
      this.retryDelay = 900;
      this._send({
        t: 'hello',
        v: 1,
        name: this.name,
        token: this.token || undefined,
        roomCode: this.roomCode,
      });
      this._emitStatus('connecting', '已连接，等待房主确认…');
      this._startConnectWatch();
    });

    conn.on('data', (raw) => {
      let msg;
      try {
        msg = typeof raw === 'string' ? JSON.parse(raw) : raw;
      } catch {
        return;
      }
      if (!msg || typeof msg !== 'object') return;
      this.lastMessageAt = Date.now();
      this._onMessage(msg);
    });

    conn.on('close', () => {
      if (this.conn !== conn) return;
      this.connected = false;
      this._emitStatus('reconnecting', '连接断开，正在重连…');
      this._scheduleReconnect();
    });

    conn.on('error', () => {
      if (this.conn !== conn) return;
      this.connected = false;
      this._emitStatus('reconnecting', '连接异常，正在重连…');
      this._scheduleReconnect();
    });
  }

  _startConnectWatch() {
    if (this._connectWatchTimer) clearTimeout(this._connectWatchTimer);
    this._connectWatchTimer = setTimeout(() => {
      if (this.destroyed || !this.conn || !this.conn.open || this.playerId) return;
      // 连接已开但一直没收到 welcome，重试
      this._cleanupConn();
      this._scheduleReconnect();
    }, 8000);
  }

  _onMessage(msg) {
    if (msg.t === 'welcome') {
      this.playerId = msg.playerId;
      this.token = msg.token;
      this.connected = true;
      if (this._connectWatchTimer) clearTimeout(this._connectWatchTimer);
      this.onWelcome({ playerId: msg.playerId, token: msg.token, roomCode: msg.roomCode });
      if (msg.state) this.onState(msg.state);
      this._emitStatus('connected', '已加入房间');
      return;
    }
    if (msg.t === 'state' && msg.state) {
      this.onState(msg.state);
      if (this.connected === false) {
        this.connected = true;
        this._emitStatus('connected', '连接已恢复');
      }
      return;
    }
    if (msg.t === 'error') {
      this.onError(msg.message || '操作失败');
      return;
    }
    if (msg.t === 'rejected') {
      this.connected = false;
      this._emitStatus('rejected', msg.reason || '无法加入房间');
      this.onRejected(msg.reason || '无法加入房间');
      this._cleanupConn();
      return;
    }
    if (msg.t === 'pong') return;
  }

  sendAction(action) {
    if (!this.conn?.open || !this.playerId) {
      this.onError('尚未连接到房间');
      return false;
    }
    this._send({ t: 'action', action });
    return true;
  }

  _send(payload) {
    if (!this.conn?.open) return;
    try {
      this.conn.send(payload);
    } catch {
      /* close/error 会触发重连 */
    }
  }

  _heartbeat() {
    if (this.destroyed || !this.conn?.open) return;
    if (this.lastMessageAt && Date.now() - this.lastMessageAt > 45000) {
      // DataChannel 假死：主动重连
      this._cleanupConn();
      this._scheduleReconnect();
      return;
    }
    this._send({ t: 'ping', ts: Date.now() });
  }

  _cleanupConn() {
    const conn = this.conn;
    this.conn = null;
    if (this._connectWatchTimer) {
      clearTimeout(this._connectWatchTimer);
      this._connectWatchTimer = null;
    }
    if (conn) {
      try { conn.close(); } catch { /* ignore */ }
    }
  }

  _scheduleReconnect(forceNewPeer = false) {
    if (this.destroyed || this.retryTimer) return;
    const delay = this.retryDelay;
    this.retryDelay = Math.min(this.retryDelay * 1.7, 6000);
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      if (this.destroyed) return;
      if (forceNewPeer || !this.peer || this.peer.destroyed) {
        this._createPeer();
        return;
      }
      if (!this.peer.open) {
        this._createPeer();
        return;
      }
      this._connect();
    }, delay);
  }

  reconnectNow() {
    if (this.destroyed) return;
    if (this.retryTimer) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
    this.retryDelay = 900;
    if (this.peer?.open) this._connect();
    else this._createPeer();
  }

  destroy() {
    this.destroyed = true;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this._cleanupConn();
    try { this.peer?.destroy(); } catch { /* ignore */ }
  }
}
