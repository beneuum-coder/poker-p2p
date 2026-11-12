/**
 * 补充反证：README 中未被现有单测覆盖的行为 + 边界风险确认。
 * - 本手进行中加入 → 下一手自动入座
 * - 房间码 6 位且去除易混淆字符
 * - 摊牌时弃牌玩家的边池 eligibility 被排除（展示层）
 * - 断线座位仍占位、首版无踢人（风险确认，不是验收失败）
 *
 * 运行：node verification/edge-cases.mjs
 */
import assert from 'node:assert/strict';
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PokerTable, makeRoomCode, ROOM_CODE_ALPHABET } from '../src/game/table.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const artifacts = path.join(root, 'verification', 'artifacts');
mkdirSync(artifacts, { recursive: true });
const checks = [];
const observations = [];
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
const read = (p) => readFileSync(path.join(root, p), 'utf8');

function findCardPaths(obj, cardSet, base = '$') {
  const hits = [];
  const walk = (v, p) => {
    if (typeof v === 'string') { if (cardSet.has(v)) hits.push({ path: p, value: v }); return; }
    if (Array.isArray(v)) return v.forEach((x, i) => walk(x, `${p}[${i}]`));
    if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) walk(x, `${p}.${k}`);
  };
  walk(obj, base);
  return hits;
}
function holes(t) {
  return new Map(t.texas.room.getPlayersBySeatStatus('on-set').map((p) => [p.id, t.texas.dealer.getHoleCardsForPlayer(p)]));
}
function passive(t, id) {
  const a = t.getState(id).you.allowed;
  assert.ok(a);
  if (a.canCheck) t.act(id, { type: 'Check' });
  else if (a.canCall) t.act(id, { type: 'Call' });
  else t.act(id, { type: 'Fold' });
}
function playToEnd(t) {
  let g = 0;
  while (t.controllerStatus === 'in_hand' && g++ < 100) passive(t, t.getState(1).activePlayerId);
  assert.equal(t.controllerStatus, 'between_hands');
}
function makeTable(n) {
  const t = new PokerTable({ hostName: '房主', roomCode: 'EDGE01' });
  for (let i = 2; i <= n; i += 1) t.addPlayer({ name: `玩家${i}` });
  return t;
}

await checkAsync('本手进行中加入：先等待，下一手自动入座（README 第 55 行）', async () => {
  const t = makeTable(3);
  t.startHand();
  const joined = t.addPlayer({ name: '迟到玩家' });
  const during = t.getState(joined.playerId);
  assert.equal(during.you.seated, false);
  assert.equal(during.players.find((p) => p.id === joined.playerId).seated, false);
  assert.equal(during.players.find((p) => p.id === joined.playerId).status, 'waiting');
  // 迟到者本手也看不到任何人的底牌
  const all = holes(t);
  const hidden = new Set();
  for (const [pid, cards] of all) if (pid !== joined.playerId) cards.forEach((c) => hidden.add(c));
  const hits = findCardPaths(JSON.parse(JSON.stringify(during)), hidden);
  assert.deepEqual(hits, [], '本手进行中加入者不应看到底牌');
  playToEnd(t);
  const next = t.startHand();
  const seated = next.players.find((p) => p.id === joined.playerId);
  assert.equal(seated.seated, true, '下一手应自动入座');
  assert.equal(next.players.filter((p) => p.seated).length, 4);
  return { playerId: joined.playerId, during: { seated: during.you.seated }, after: { seated: seated.seated, handNo: next.handNo } };
});

await checkAsync('房间码：6 位、来自 32 字符表、不含 0/1/I/O（README 第 37 行）', async () => {
  const bad = [];
  for (let i = 0; i < 2000; i += 1) {
    const code = makeRoomCode();
    if (code.length !== 6) bad.push({ code, why: 'length' });
    for (const ch of code) if (!ROOM_CODE_ALPHABET.includes(ch)) bad.push({ code, why: `char ${ch}` });
  }
  assert.deepEqual(bad, []);
  assert.equal(ROOM_CODE_ALPHABET.includes('0'), false);
  assert.equal(ROOM_CODE_ALPHABET.includes('1'), false);
  assert.equal(ROOM_CODE_ALPHABET.includes('I'), false);
  assert.equal(ROOM_CODE_ALPHABET.includes('O'), false);
  // 页面侧 generateCode 使用同一字母表
  const main = read('src/main.js');
  assert.ok(main.includes("for (const b of bytes) out += ROOM_CODE_ALPHABET[b % ROOM_CODE_ALPHABET.length]"));
  return { alphabet: ROOM_CODE_ALPHABET, samples: 2000 };
});

await checkAsync('边池展示：摊牌时弃牌玩家被排除出所有 sidePot.eligible，金额仍按投入拆分', async () => {
  const t = makeTable(3);
  t.__setNextButton(1);
  // 3 人桌按钮位(1)翻前先行动：1 跟注 20、2 跟注 20、3 加注到 60、1 跟注、2 弃牌(共投入 20)。
  // 翻牌后 3/1 过牌到摊牌。contribution = 1:60, 2:20, 3:60 → 主池 60 + 边池 80。
  t.startHand();
  assert.equal(t.getState(1).activePlayerId, 1);
  passive(t, 1); // BTN call 20
  passive(t, 2); // SB call 到 20
  t.act(3, { type: 'Raise', additionalAmount: 40 }); // BB 从 20 加到 60
  passive(t, 1); // BTN call 到 60
  t.act(2, { type: 'Fold' }); // SB 弃牌，总投入 20
  assert.equal((t.getState(1).stage), 'flop');
  assert.equal((t.getState(1).pot.total), 140);
  // 翻牌/转牌/河牌：3 与 1 相互过牌到摊牌
  let g = 0;
  while (t.controllerStatus === 'in_hand' && g++ < 50) {
    const st = t.getState(1);
    passive(t, st.activePlayerId);
  }
  const final = t.getState(1);
  assert.equal(final.result.outcome, 'showdown');
  assert.equal(final.result.revealed.length, 2);
  assert.equal(final.result.revealed.includes(2), false, '弃牌玩家不应公开');
  assert.equal(final.players.find((p) => p.id === 2).cards, undefined);
  const pots = final.pot.sidePots;
  assert.deepEqual(pots.map((p) => p.amount), [60, 80]);
  for (const pot of pots) assert.equal(pot.eligible.includes(2), false, '弃牌玩家不应有资格分任何池');
  assert.equal(pots.reduce((s, p) => s + p.amount, 0), 140);
  return { awards: final.result.awards, sidePots: pots };
});

await checkAsync('风险确认：断线玩家仍占座位，满 6 人后第 7 人无法加入，且 UI 无踢人入口', async () => {
  const t = makeTable(6);
  t.setConnected(2, false);
  const st = t.getState(1);
  assert.equal(st.players.find((p) => p.id === 2).connected, false);
  assert.equal(st.players.find((p) => p.id === 2).seated, true);
  assert.throws(() => t.addPlayer({ name: '第七人' }), /房间已满/);
  const main = read('src/main.js');
  const hasKick = /kick|踢人|移除玩家|removePlayer/.test(main);
  observations.push({
    id: 'no-kick-disconnected-seat',
    severity: 'low',
    summary: '断线玩家永久占座，满 6 人后无踢人入口；首版未承诺踢人，属于可用性风险',
    evidence: { disconnectedSeatStillCounts: true, seventhRejected: true, hasKickControl: hasKick },
  });
  return { disconnectedStillSeated: true, hasKick };
});

const failed = checks.filter((c) => !c.ok);
const report = { generatedAt: new Date().toISOString(), checks, observations, summary: { total: checks.length, failed: failed.length } };
writeFileSync(path.join(artifacts, 'edge-cases.json'), JSON.stringify(report, null, 2));
console.log(`\n结果: ${checks.length - failed.length}/${checks.length} 通过, 风险观察 ${observations.length} 条`);
process.exitCode = failed.length ? 1 : 0;
