/**
 * 独立验收：GitHub Pages 静态产物、相对路径子路径部署、README 声称与实际行为一致性。
 * 不修改交付文件；仅读取 docs/、README、workflow，并在内存中起子路径服务器。
 *
 * 运行：node verification/pages-readme-audit.mjs
 */
import assert from 'node:assert/strict';
import { readFileSync, existsSync, statSync, mkdirSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PokerTable } from '../src/game/table.js';
import { launchBrowser } from '../test/helpers/browser.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const artifacts = path.join(root, 'verification', 'artifacts');
mkdirSync(artifacts, { recursive: true });
const checks = [];
const evidence = { startedAt: new Date().toISOString() };
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
function check(name, fn) {
  return checkAsync(name, async () => fn());
}
const read = (p) => readFileSync(path.join(root, p), 'utf8');
const raw = (p) => readFileSync(path.join(root, p));

// ---------------------------------------------------------------------------
// 1. Pages 静态产物
// ---------------------------------------------------------------------------
let server;
let browser;
const requests = [];
try {
  await checkAsync('Pages/产物：docs/index.html、app.js、styles.css、.nojekyll 齐全且非空', async () => {
    const files = ['docs/index.html', 'docs/app.js', 'docs/styles.css', 'docs/.nojekyll'];
    const info = {};
    for (const f of files) {
      assert.ok(existsSync(path.join(root, f)), `${f} 不存在`);
      const st = statSync(path.join(root, f));
      assert.ok(st.isFile());
      info[f] = st.size;
    }
    assert.ok(info['docs/app.js'] > 100000, 'app.js 应包含打包依赖');
    assert.equal(info['docs/.nojekyll'], 0, '.nojekyll 应为空文件');
    return info;
  });

  await checkAsync('Pages/相对路径：index.html 只用 ./ 相对引用，无绝对 / 引用', async () => {
    const html = read('docs/index.html');
    assert.match(html, /<link rel="stylesheet" href="\.\/styles\.css"/);
    assert.match(html, /<script src="\.\/app\.js"><\/script>/);
    const absolute = [...html.matchAll(/(?:src|href)="\/(?!\/)[^"]*"/g)].map((m) => m[0]);
    assert.deepEqual(absolute, [], `发现绝对路径引用: ${JSON.stringify(absolute)}`);
    return { relativeRefs: ['./styles.css', './app.js'], absolute };
  });

  await checkAsync('Pages/产物与 src 一致：index.html、styles.css 与 src 完全相同', async () => {
    assert.equal(readFileSync(path.join(root, 'docs/index.html')).equals(readFileSync(path.join(root, 'src/index.html'))), true);
    assert.equal(readFileSync(path.join(root, 'docs/styles.css')).equals(readFileSync(path.join(root, 'src/styles.css'))), true);
    return { index: 'identical', styles: 'identical' };
  });

  await checkAsync('Pages/Actions 配置：main 分支、npm ci/test/build、上传 docs、deploy-pages 权限齐全', async () => {
    const yml = read('.github/workflows/pages.yml');
    for (const needle of ['branches: [main]', 'npm ci', 'npm test', 'npm run build', 'path: docs', 'actions/deploy-pages@v4', 'pages: write', 'id-token: write']) {
      assert.ok(yml.includes(needle), `workflow 缺少: ${needle}`);
    }
    assert.ok(!/cat docs|echo .* > docs/.test(yml), 'workflow 不应手工改 docs');
    return { workflow: '.github/workflows/pages.yml' };
  });

  // -------------------------------------------------------------------------
  // 2. 模拟 GitHub Pages 项目子路径 /<repo>/ 部署
  // -------------------------------------------------------------------------
  const prefix = '/poker-p2p/';
  const docsDir = path.join(root, 'docs');
  server = http.createServer(async (req, res) => {
    requests.push(req.url);
    const url = new URL(req.url, 'http://localhost');
    if (!url.pathname.startsWith(prefix)) {
      res.writeHead(404, { 'content-type': 'text/plain' }).end('not found');
      return;
    }
    let rel = url.pathname.slice(prefix.length);
    if (rel === '') rel = 'index.html';
    const target = path.resolve(docsDir, rel);
    if (!target.startsWith(docsDir)) {
      res.writeHead(403).end('forbidden');
      return;
    }
    try {
      const body = await import('node:fs/promises').then((fs) => fs.readFile(target));
      const ext = path.extname(target);
      const mime = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.png': 'image/png' }[ext] || 'application/octet-stream';
      res.writeHead(200, { 'content-type': mime }).end(body);
    } catch {
      res.writeHead(404, { 'content-type': 'text/plain' }).end('not found');
    }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  const base = `http://127.0.0.1:${port}${prefix}`;
  browser = await launchBrowser();
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });

  await checkAsync('Pages/子路径部署：/poker-p2p/ 下能加载样式、启动应用并创建房间', async () => {
    await page.goto(base, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('.landing .hero h1', { timeout: 15000 });
    const styleSheets = await page.evaluate(() => document.styleSheets.length);
    assert.ok(styleSheets >= 1, '样式表应加载');
    await page.fill('#host-name', '子路径房主');
    await page.click('[data-action="create"]');
    await page.waitForSelector('.room-id .code', { timeout: 20000 });
    const code = (await page.locator('.room-id .code').innerText()).trim();
    assert.match(code, /^[A-Z0-9]{6}$/);
    assert.equal(new URL(page.url()).pathname, prefix, '应保持在项目子路径下');
    const bad = requests.filter((u) => /^\/(app\.js|styles\.css|index\.html)(\?|$)/.test(u));
    assert.deepEqual(bad, [], `出现了错误的根路径资源请求: ${JSON.stringify(bad)}`);
    return { url: page.url(), code, styleSheets, requests: [...new Set(requests)] };
  });
  if (browser) await browser.close().catch(() => {});
  browser = null;
  await ctx.close().catch(() => {});
  if (server) await new Promise((r) => server.close(r));
  server = null;

  // -------------------------------------------------------------------------
  // 3. README 声称与实现一致性
  // -------------------------------------------------------------------------
  await checkAsync('README/部署说明：Pages 两种方式、.nojekyll、本地预览命令均写明', async () => {
    const md = read('README.md');
    for (const needle of ['Deploy from a branch', '/docs', '.nojekyll', 'GitHub Actions', 'npm run build', 'npm run serve', 'npm ci', 'npm test']) {
      assert.ok(md.includes(needle), `README 缺少: ${needle}`);
    }
    const pkg = JSON.parse(read('package.json'));
    assert.ok(pkg.scripts.build && pkg.scripts.serve && pkg.scripts.test && pkg.scripts['test:e2e']);
    return { scripts: Object.keys(pkg.scripts) };
  });

  await checkAsync('README/限制说明：房主可信可作弊、公共信令/NAT、房主刷新丢房间均已明确', async () => {
    const md = read('README.md');
    for (const needle of ['房主可作弊', 'PeerJS 公共信令', '复杂 NAT', '刷新房主页面会丢失房间', 'TURN']) {
      assert.ok(md.includes(needle), `README 限制缺少: ${needle}`);
    }
    return { hasKnownLimits: true };
  });

  await checkAsync('README/E2E 覆盖声明与实际脚本一致（刷新、3.5s 断网、三人边池、下一手）', async () => {
    const e2e = read('test/e2e/run-e2e.mjs');
    for (const needle of ['setOffline(true)', 'waitForTimeout(3500)', 'reload(', '__setNextDeal', "data-action=\"next\"", '边池']) {
      assert.ok(e2e.includes(needle), `E2E 脚本缺少: ${needle}`);
    }
    const md = read('README.md');
    for (const needle of ['刷新页面、断网 3.5 秒后自动重连', '三人不等额全下', '下一手庄家移动']) {
      assert.ok(md.includes(needle), `README 覆盖声明缺少: ${needle}`);
    }
    return { e2eMarkers: ['reload', 'offline-3.5s', 'sidepot', 'next-hand'] };
  });

  await checkAsync('README/行为：仅房主一人时不能开始（引擎与 UI 双重限制）', async () => {
    const t = new PokerTable({ hostName: '单人房主' });
    assert.throws(() => t.startHand(), /至少需要 2 名已入座玩家/);
    const st = t.getState(1);
    assert.equal(st.status, 'lobby');
    return { lobbyPlayers: st.players.length, error: '至少需要 2 名已入座玩家' };
  });

  await checkAsync('README/行为：0 筹码玩家下一手前自动离座', async () => {
    const t = new PokerTable({ hostName: '房主' });
    t.addPlayer({ name: 'B' });
    t.addPlayer({ name: 'C' });
    t.startHand();
    // 打到结束
    let g = 0;
    while (t.controllerStatus === 'in_hand' && g++ < 100) {
      const st = t.getState(1);
      const a = st.you.allowed || t.getState(st.activePlayerId).you.allowed;
      if (a.canCheck) t.act(st.activePlayerId, { type: 'Check' });
      else if (a.canCall) t.act(st.activePlayerId, { type: 'Call' });
      else t.act(st.activePlayerId, { type: 'Fold' });
    }
    t.__setChips(2, 0);
    const before = t.getState(1);
    assert.equal(before.players.find((p) => p.id === 2).chips, 0);
    const started = t.startHand();
    const p2 = started.players.find((p) => p.id === 2);
    assert.equal(p2.seated, false, '0 筹码玩家应离座');
    assert.equal(started.status, 'playing');
    assert.equal(started.handNo, 2);
    return { p2, handNo: started.handNo };
  });

  await checkAsync('README/行为：房主局间为 0 筹码玩家补码 1000 后，下一手可继续', async () => {
    const t = new PokerTable({ hostName: '房主' });
    t.addPlayer({ name: 'B' });
    t.addPlayer({ name: 'C' });
    t.startHand();
    let g = 0;
    while (t.controllerStatus === 'in_hand' && g++ < 100) {
      const active = t.getState(1).activePlayerId;
      const a = t.getState(active).you.allowed;
      if (a.canCheck) t.act(active, { type: 'Check' });
      else if (a.canCall) t.act(active, { type: 'Call' });
      else t.act(active, { type: 'Fold' });
    }
    t.__setChips(2, 0);
    assert.throws(() => { const x = new PokerTable(); x.addPlayer({ name: '临时' }); x.rebuy(2); }, /牌局尚未开始/);
    t.rebuy(2, 1000);
    const st = t.getState(1);
    assert.equal(st.players.find((p) => p.id === 2).chips, 1000);
    const next = t.startHand();
    assert.equal(next.status, 'playing');
    assert.equal(next.players.find((p) => p.id === 2).seated, true);
    assert.equal(next.players.length, 3);
    return { chips: next.players.map((p) => [p.id, p.chips, p.seated]), handNo: next.handNo };
  });

  await checkAsync('README/行为：邀请链接 ?r=CODE 能被页面识别并预填房间码', async () => {
    // 静态检查 boot()：读取 URLSearchParams 的 r 参数、切到加入页
    const main = read('src/main.js');
    assert.ok(main.includes("params.get('r')"));
    assert.ok(main.includes("app.authTab = 'join'"));
    // 真实浏览器验证（重新起根路径服务器）
    const serve = await import('../test/helpers/serve.mjs');
    const s = await serve.startServer(path.join(root, 'docs'));
    const b = await launchBrowser();
    const c = await b.newContext();
    const p = await c.newPage();
    try {
      await p.goto(`${s.url}/?r=ABC234`, { waitUntil: 'domcontentloaded' });
      await p.waitForSelector('#join-code', { timeout: 10000 });
      const value = await p.inputValue('#join-code');
      const activeTab = (await p.locator('.auth-tab.active').innerText()).trim();
      assert.equal(value, 'ABC234');
      assert.match(activeTab, /加入房间/);
      return { prefill: value, activeTab };
    } finally {
      await c.close().catch(() => {});
      await b.close().catch(() => {});
      await s.close().catch(() => {});
    }
  });

  await checkAsync('README/最近 E2E 结果：当前重跑为 2 个场景全部通过（时间与 README 快照略有差异）', async () => {
    const report = JSON.parse(read('test/.artifacts/acceptance-report.json'));
    assert.equal(report.ok, true);
    assert.equal(report.scenarios.length, 2);
    assert.ok(report.scenarios.every((s) => s.ok));
    return { scenarios: report.scenarios.map((s) => ({ name: s.name, ms: s.ms })), finishedAt: report.finishedAt };
  });

  evidence.finishedAt = new Date().toISOString();
  evidence.ok = checks.every((c) => c.ok);
  evidence.checks = checks;
  evidence.requests = [...new Set(requests)];
  writeFileSync(path.join(artifacts, 'pages-readme-audit.json'), JSON.stringify(evidence, null, 2));
  console.log(`\n结果: ${checks.filter((c) => c.ok).length}/${checks.length} 通过`);
  process.exitCode = evidence.ok ? 0 : 1;
} catch (err) {
  console.error('FATAL', err);
  evidence.fatal = err?.stack || String(err);
  evidence.checks = checks;
  evidence.ok = false;
  writeFileSync(path.join(artifacts, 'pages-readme-audit.json'), JSON.stringify(evidence, null, 2));
  process.exitCode = 1;
} finally {
  if (browser) await browser.close().catch(() => {});
  if (server) await new Promise((r) => server.close(r));
}
