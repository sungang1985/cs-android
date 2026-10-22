// Build: bundles src/main.ts with esbuild into dist/, copies web/ static files, generates PWA icons,
// stamps the service worker with a content hash so updates propagate.
// Usage: node tools/build.mjs [--watch] [--serve] [--dev]
import esbuild from 'esbuild';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { drawIcon } from './png.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dist = path.join(root, 'dist');
const web = path.join(root, 'web');
const args = new Set(process.argv.slice(2));
const dev = args.has('--dev') || args.has('--watch');

function copyDir(src, dst) {
  fs.mkdirSync(dst, { recursive: true });
  for (const e of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, e.name), d = path.join(dst, e.name);
    if (e.isDirectory()) copyDir(s, d); else fs.copyFileSync(s, d);
  }
}

function hashFiles(files) {
  const h = crypto.createHash('sha1');
  for (const f of files.sort()) { h.update(path.relative(dist, f)); h.update(fs.readFileSync(f)); }
  return h.digest('hex').slice(0, 10);
}

function listFiles(dir) {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...listFiles(p)); else out.push(p);
  }
  return out;
}

function postBuild() {
  copyDir(web, dist);
  fs.mkdirSync(path.join(dist, 'icons'), { recursive: true });
  for (const s of [192, 512]) {
    fs.writeFileSync(path.join(dist, 'icons', `icon-${s}.png`), drawIcon(s));
    fs.writeFileSync(path.join(dist, 'icons', `icon-${s}-maskable.png`), drawIcon(s, { maskable: true }));
  }
  // Stamp service worker with a hash of every file except itself, and list them for precaching.
  const swPath = path.join(dist, 'sw.js');
  if (fs.existsSync(swPath)) {
    const files = listFiles(dist).filter((f) => f !== swPath && !f.endsWith('.map'));
    const version = hashFiles(files);
    const assets = files.map((f) => '/' + path.relative(dist, f).split(path.sep).join('/'));
    let sw = fs.readFileSync(swPath, 'utf8');
    sw = sw.replace('__BUILD_VERSION__', version).replace('"__PRECACHE__"', JSON.stringify(assets));
    fs.writeFileSync(swPath, sw);
    const idx = path.join(dist, 'index.html');
    if (fs.existsSync(idx)) fs.writeFileSync(idx, fs.readFileSync(idx, 'utf8').replaceAll('__BUILD_VERSION__', version));
    console.log(`[build] version ${version}, ${files.length} files`);
  }
}

const buildOptions = {
  entryPoints: [path.join(root, 'src', 'main.ts')],
  bundle: true,
  outfile: path.join(dist, 'app.js'),
  format: 'iife',
  target: ['es2020', 'chrome90'],
  platform: 'browser',
  minify: !dev,
  sourcemap: dev ? 'inline' : false,
  define: { 'process.env.NODE_ENV': dev ? '"development"' : '"production"', '__DEV__': dev ? 'true' : 'false' },
  legalComments: 'none',
  logLevel: 'info',
  plugins: [{
    name: 'post-build',
    setup(b) { b.onEnd((r) => { if (r.errors.length === 0) postBuild(); }); },
  }],
};

fs.rmSync(dist, { recursive: true, force: true });
fs.mkdirSync(dist, { recursive: true });

if (args.has('--watch')) {
  const ctx = await esbuild.context(buildOptions);
  await ctx.watch();
  if (args.has('--serve')) {
    const { startServer } = await import('./serve.mjs');
    const { url } = await startServer(dist, Number(process.env.PORT || 8080));
    console.log(`[dev] serving ${url}`);
  }
} else {
  await esbuild.build(buildOptions);
  const size = fs.statSync(path.join(dist, 'app.js')).size;
  console.log(`[build] app.js ${(size / 1024).toFixed(0)} KB`);
}
