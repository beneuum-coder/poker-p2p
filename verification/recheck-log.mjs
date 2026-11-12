/**
 * d6a4601 复核：局间日志保留修复。
 * - 3 人局：本手加入的等待玩家在下一手入座；某玩家筹码置 0 后开始下一手，
 *   getState(1).log 应同时保留“入座”和“筹码耗尽”提示。
 * - 2 人局：某玩家筹码置 0 后 startHand 抛“至少需要 2 名已入座玩家”，
 *   但 getState(1).log 仍应保留“筹码耗尽”提示。
 *
 * 运行：node verification/recheck-log.mjs
 */
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PokerTable } from '../src/game/table.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const artifacts = path.join(root, 'verification', 'artifacts');
mkdirSync(artifacts, { recursive: true });
const results = [];

function makeTable(n) {
  const t = new PokerTable({ hostName: '房主', roomCode: 'LOG4601' });
  for (let i = 2; i <= n; i += 1) t.addPlayer({ name: `玩家${i}` });
  return t;
}
function passive(t, id) {
  const a = t.getState(id).you.allowed;
  assert.ok(a, `玩家 ${id} 应有 allowed`);
  if (a.canCheck) t.act(id, { type: 'Check' });
  else if (a.canCall) t.act(id, { type: 'Call' });
  else t.act(id, { type: 'Fold' });
}
function playToEnd(t) {
  let guard = 0;
  while (t.controllerStatus === 'in_hand' && guard++ < 100) passive(t, t.getState(1).activePlayerId);
  assert.equal(t.controllerStatus, 'between_hands', '本手应结束');
}

// ---- 3 人：等待玩家入座 + 0 筹码玩家离座，两条日志都要保留 ----
{
  const t = makeTable(3);
  t.startHand();
  const late = t.addPlayer({ name: '迟到玩家' });
  assert.equal(t.getState(late.playerId).you.seated, false);
  playToEnd(t);
  t.__setChips(2, 0);
  const st = t.startHand();
  const log = st.log.map((l) => l.text);
  assert.ok(log.some((x) => x.includes('迟到玩家') && x.includes('入座')), `应保留入座日志: ${JSON.stringify(log)}`);
  assert.ok(log.some((x) => x.includes('玩家2') && x.includes('筹码耗尽')), `应保留筹码耗尽日志: ${JSON.stringify(log)}`);
  assert.ok(log.some((x) => x.includes('第 2 手开始')), '应有第 2 手开始日志');
  assert.equal(st.players.find((p) => p.id === 2).seated, false, '0 筹码玩家应已离座');
  assert.equal(st.players.find((p) => p.id === late.playerId).seated, true, '等待玩家应已入座');
  results.push({ scenario: '3-player+pending', ok: true, log, seated: st.players.map((p) => [p.id, p.seated, p.chips]) });
  console.log('PASS 3 人局日志:');
  console.log(log.map((x) => `  - ${x}`).join('\n'));
}

// ---- 2 人：0 筹码导致无法开手，但日志仍保留 ----
{
  const t = makeTable(2);
  t.startHand();
  playToEnd(t);
  t.__setChips(2, 0);
  let error = null;
  try {
    t.startHand();
  } catch (err) {
    error = err.message;
  }
  assert.match(String(error), /至少需要 2 名已入座玩家/);
  const log = t.getState(1).log.map((l) => l.text);
  assert.ok(log.some((x) => x.includes('玩家2') && x.includes('筹码耗尽')), `2 人局应保留筹码耗尽日志: ${JSON.stringify(log)}`);
  results.push({ scenario: '2-player-start-rejected', ok: true, error, log });
  console.log('PASS 2 人局日志（开手被拒但日志保留）:');
  console.log(log.map((x) => `  - ${x}`).join('\n'));
}

const report = { generatedAt: new Date().toISOString(), head: 'd6a4601', results, ok: results.every((r) => r.ok) };
writeFileSync(path.join(artifacts, 'recheck-log.json'), JSON.stringify(report, null, 2));
console.log(`\n结果: ${results.length}/${results.length} 通过`);
