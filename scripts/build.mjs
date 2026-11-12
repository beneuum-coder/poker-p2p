import { build } from 'esbuild';
import { cp, mkdir, rm, stat, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const src = path.join(root, 'src');
const out = path.join(root, 'docs');

await rm(out, { recursive: true, force: true });
await mkdir(out, { recursive: true });

await build({
  entryPoints: [path.join(src, 'main.js')],
  bundle: true,
  format: 'iife',
  target: ['es2020'],
  outfile: path.join(out, 'app.js'),
  sourcemap: false,
  minify: true,
  legalComments: 'none',
  define: { 'process.env.NODE_ENV': '"production"' },
  logLevel: 'silent',
});

await cp(path.join(src, 'index.html'), path.join(out, 'index.html'));
await cp(path.join(src, 'styles.css'), path.join(out, 'styles.css'));
await writeFile(path.join(out, '.nojekyll'), '');

const app = await stat(path.join(out, 'app.js'));
console.log(`\n静态站点已生成: ${path.relative(root, out)}\\  (app.js ${(app.size / 1024).toFixed(0)} KB)`);
