import { chromium } from 'playwright-core';
import { existsSync, readdirSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

function candidateDirs() {
  const dirs = [];
  if (process.env.PLAYWRIGHT_BROWSERS_PATH) dirs.push(process.env.PLAYWRIGHT_BROWSERS_PATH);
  if (process.platform === 'win32') {
    if (process.env.LOCALAPPDATA) dirs.push(path.join(process.env.LOCALAPPDATA, 'ms-playwright'));
  } else {
    dirs.push(path.join(os.homedir(), '.cache', 'ms-playwright'));
    dirs.push(path.join(os.homedir(), 'Library', 'Caches', 'ms-playwright'));
  }
  return dirs;
}

export function findChromiumExecutable() {
  if (process.env.TXP_CHROMIUM) return process.env.TXP_CHROMIUM;
  try {
    const bundled = chromium.executablePath();
    if (bundled && existsSync(bundled)) return bundled;
  } catch { /* ignore */ }
  for (const base of candidateDirs()) {
    if (!existsSync(base)) continue;
    const versions = readdirSync(base)
      .filter((name) => name.startsWith('chromium-'))
      .sort()
      .reverse();
    for (const version of versions) {
      const candidates = process.platform === 'win32'
        ? [
            path.join(base, version, 'chrome-win64', 'chrome.exe'),
            path.join(base, version, 'chrome-win', 'chrome.exe'),
          ]
        : process.platform === 'darwin'
          ? [path.join(base, version, 'chrome-mac', 'Chromium.app', 'Contents', 'MacOS', 'Chromium')]
          : [path.join(base, version, 'chrome-linux', 'chrome'), path.join(base, version, 'chrome-linux64', 'chrome')];
      for (const candidate of candidates) {
        if (existsSync(candidate)) return candidate;
      }
    }
  }
  throw new Error('找不到 Chromium。请运行 `npx playwright install chromium`，或设置 TXP_CHROMIUM 指向 chrome 可执行文件。');
}

export async function launchBrowser() {
  return chromium.launch({
    executablePath: findChromiumExecutable(),
    headless: true,
    args: ['--no-sandbox', '--disable-dev-shm-usage'],
  });
}
