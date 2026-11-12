/**
 * 诊断：房主"消失"的不同方式下，玩家多久出现 .conn-banner / 重连状态。
 * 仅用于本轮复核取证，不修改交付文件。
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
const results = [];
const contexts = [];
async function newPage(label) {
  const ctx = await browser.newContext();
  contexts.push(ctx);
  const page = await ctx.newPage();
  page.on('pageerror', (e) => results.push({ error: `${label}: ${e.message}` }));
  return page;
}
async function setup() {
  const host = await newPage('host');
  await host.goto(server.url, { waitUntil: 'domcontentloaded' });
  await host.fill('#host-name', '房主诊断');
  await host.click('[data-action="create"]');
  await host.waitForSelector('.room-id .code', { timeout: 25000 });
  const code = (await host.locator('.room-id .code').innerText()).trim();
  const guest = await newPage('guest');
  await guest.goto(`${server.url}/?r=${code}`, { waitUntil: 'domcontentloaded' });
  await guest.fill('#join-name', '玩家诊断');
  await guest.click('[data-action="join"]');
  await guest.waitForSelector('.room-id .code', { timeout: 25000 });
  await host.waitForFunction(() => document.querySelectorAll('.player-row').length === 2, null, { timeout: 20000 });
  await host.click('.table-overlay [data-action="start"]');
  await host.waitForFunction(() => document.querySelector('.stage-label')?.innerText.includes('翻牌前'), null, { timeout: 20000 });
  await host.waitForTimeout(500);
  return { host, guest, code };
}
async function state(page) {
  return page.evaluate(() => {
    const b = document.querySelector('#conn-banner');
    const p = document.querySelector('#net-pill');
    return {
      banner: !!b && b.offsetParent !== null,
      pill: p ? p.innerText.trim() : '',
      hasRoom: !!document.querySelector('.room-id .code'),
    };
  });
}
async function watch(guest, label, ms = 70000) {
  const t0 = Date.now();
  let firstBanner = null;
  let firstNotConnected = null;
  const samples = [];
  while (Date.now() - t0 < ms) {
    const s = await state(guest);
    const elapsed = Date.now() - t0;
    if (s.pill !== '已连接' && !firstNotConnected) firstNotConnected = { elapsed, ...s };
    if (s.banner && !firstBanner) firstBanner = { elapsed, ...s };
    if (samples.length < 200) samples.push({ elapsed, ...s });
    if (firstBanner && elapsed > firstBanner.elapsed + 3000) break;
    await guest.waitForTimeout(500);
  }
  const final = await state(guest);
  const r = { label, firstNotConnected, firstBanner, final, samples: samples.filter((_, i) => i % 5 === 0 || i < 3) };
  results.push(r);
  console.log(`${label}: firstNotConnected=${firstNotConnected ? firstNotConnected.elapsed + 'ms ' + firstNotConnected.pill : 'NONE'} firstBanner=${firstBanner ? firstBanner.elapsed + 'ms' : 'NONE'} finalPill=${final.pill}`);
  return r;
}

try {
  // A. page.close()
  {
    const { host, guest } = await setup();
    await host.close();
    await watch(guest, 'A:page.close', 70000);
    await guest.context().close().catch(() => {});
  }
  // B. context.close()
  {
    const { host, guest } = await setup();
    await host.context().close();
    await watch(guest, 'B:context.close', 20000);
    await guest.context().close().catch(() => {});
  }
  // C. host.destroy() via debug object (graceful app-level teardown)
  {
    const { host, guest } = await setup();
    await host.evaluate(() => window.__txpHost.destroy());
    await watch(guest, 'C:__txpHost.destroy', 20000);
    await host.context().close().catch(() => {});
    await guest.context().close().catch(() => {});
  }
  // D. page.reload()
  {
    const { host, guest } = await setup();
    await host.reload({ waitUntil: 'domcontentloaded' });
    await watch(guest, 'D:page.reload', 20000);
    await host.context().close().catch(() => {});
    await guest.context().close().catch(() => {});
  }
  writeFileSync(path.join(artifacts, 'recheck-banner-variants.json'), JSON.stringify({ generatedAt: new Date().toISOString(), results }, null, 2));
  console.log('written recheck-banner-variants.json');
} catch (err) {
  console.error('FATAL', err);
  writeFileSync(path.join(artifacts, 'recheck-banner-variants.json'), JSON.stringify({ error: String(err), results }, null, 2));
  process.exitCode = 1;
} finally {
  for (const c of contexts) await c.close().catch(() => {});
  await browser.close().catch(() => {});
  await server.close().catch(() => {});
}
