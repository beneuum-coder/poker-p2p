/**
 * 联机建立延迟：房主建房 → 玩家输入房间码加入 → 双方看到 2/6 人的耗时。
 * 运行：node verification/join-latency.mjs
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startServer } from '../test/helpers/serve.mjs';
import { launchBrowser } from '../test/helpers/browser.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const artifacts = path.join(root, 'verification', 'artifacts');
mkdirSync(artifacts, { recursive: true });
const server = await startServer(path.join(root, 'docs'));
const browser = await launchBrowser();
const runs = [];
const contexts = [];
const errors = [];
async function newPage() {
  const ctx = await browser.newContext();
  contexts.push(ctx);
  const p = await ctx.newPage();
  p.on('pageerror', (e) => errors.push(e.message));
  return p;
}
try {
  for (let i = 1; i <= 3; i += 1) {
    const host = await newPage();
    await host.goto(server.url, { waitUntil: 'domcontentloaded' });
    await host.fill('#host-name', `房主${i}`);
    await host.click('[data-action="create"]');
    await host.waitForSelector('.room-id .code', { timeout: 25000 });
    const code = (await host.locator('.room-id .code').innerText()).trim();
    const guest = await newPage();
    const t0 = Date.now();
    await guest.goto(`${server.url}/?r=${code}`, { waitUntil: 'domcontentloaded' });
    await guest.fill('#join-name', `玩家${i}`);
    await guest.click('[data-action="join"]');
    await guest.waitForSelector('.room-id .code', { timeout: 25000 });
    const guestVisibleMs = Date.now() - t0;
    await host.waitForFunction(() => document.querySelectorAll('.player-row').length === 2, null, { timeout: 20000 });
    const hostVisibleMs = Date.now() - t0;
    const hostMeta = (await host.locator('.room-meta').innerText()).replace(/\n/g, ' | ');
    const guestMeta = (await guest.locator('.room-meta').innerText()).replace(/\n/g, ' | ');
    runs.push({ code, guestVisibleMs, hostVisibleMs, hostMeta, guestMeta });
    console.log(`run ${i}: code=${code} guestRoom=${guestVisibleMs}ms hostSees2=${hostVisibleMs}ms`);
    await host.context().close().catch(() => {});
    await guest.context().close().catch(() => {});
  }
  const allWithin = runs.every((r) => r.hostVisibleMs < 10000);
  const report = {
    generatedAt: new Date().toISOString(),
    runs,
    summary: {
      minMs: Math.min(...runs.map((r) => r.hostVisibleMs)),
      maxMs: Math.max(...runs.map((r) => r.hostVisibleMs)),
      allWithin10s: allWithin,
    },
    errors,
    ok: allWithin && errors.length === 0,
  };
  writeFileSync(path.join(artifacts, 'join-latency.json'), JSON.stringify(report, null, 2));
  console.log(`\n结果: ${allWithin ? 'PASS' : 'FAIL'} 全部 <10s; max=${report.summary.maxMs}ms; errors=${errors.length}`);
  process.exitCode = report.ok ? 0 : 1;
} catch (err) {
  console.error('FATAL', err);
  writeFileSync(path.join(artifacts, 'join-latency.json'), JSON.stringify({ ok: false, error: String(err), runs }, null, 2));
  process.exitCode = 1;
} finally {
  for (const c of contexts) await c.close().catch(() => {});
  await browser.close().catch(() => {});
  await server.close().catch(() => {});
}
