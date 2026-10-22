// End-to-end runner: serves dist/, launches headless Chromium with a phone profile (Pixel 5, landscape,
// touch) and software WebGL, runs every scenario in tests/e2e/*.mjs, captures screenshots and console
// errors into .e2e-out/. Exit code is non-zero if any scenario fails or the page throws.
// Usage: node tools/e2e.mjs [--grep name] [--desktop] [--headed]
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { chromium, devices } from 'playwright';
import { startServer } from './serve.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dist = path.join(root, 'dist');
const outDir = path.join(root, '.e2e-out');
const args = process.argv.slice(2);
const grep = args.includes('--grep') ? args[args.indexOf('--grep') + 1] : null;
const desktop = args.includes('--desktop');

if (!fs.existsSync(path.join(dist, 'index.html'))) {
  console.error('dist/ missing — run `npm run build` first');
  process.exit(2);
}
fs.rmSync(outDir, { recursive: true, force: true });
fs.mkdirSync(outDir, { recursive: true });

const { server, url } = await startServer(dist);
const browser = await chromium.launch({
  headless: !args.includes('--headed'),
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--autoplay-policy=no-user-gesture-required'],
});

const scenarioDir = path.join(root, 'tests', 'e2e');
const files = fs.readdirSync(scenarioDir).filter((f) => f.endsWith('.mjs') && (!grep || f.includes(grep))).sort();
const results = [];

for (const file of files) {
  const name = file.replace(/\.mjs$/, '');
  const t0 = Date.now();
  const errors = [];
  const logs = [];
  const context = await browser.newContext(desktop
    ? { viewport: { width: 1280, height: 720 }, hasTouch: false }
    : { ...devices['Pixel 5 landscape'] });
  const page = await context.newPage();
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  page.on('console', (m) => {
    const line = `[${m.type()}] ${m.text()}`;
    logs.push(line);
    if (m.type() === 'error') errors.push(line);
  });
  const shots = [];
  const ctx = {
    page, url, name, desktop,
    log: (...a) => logs.push(`[scenario] ${a.join(' ')}`),
    /** Save a screenshot named `<scenario>-<label>.png` */
    shot: async (label) => { const p = path.join(outDir, `${name}-${label}.png`); await page.screenshot({ path: p }); shots.push(p); return p; },
    /** Throw if condition false */
    expect: (cond, msg) => { if (!cond) throw new Error(`expectation failed: ${msg}`); },
    /** Wait until the page exposes the debug API */
    ready: async (timeout = 30000) => { await page.waitForFunction(() => globalThis.__cs && globalThis.__cs.ready === true, null, { timeout }); },
    /** Call a debug API function in the page */
    dbg: (fn, ...a) => page.evaluate(([fn, a]) => globalThis.__cs[fn](...a), [fn, a]),
  };
  let status = 'pass', error = null;
  try {
    const mod = await import(pathToFileURL(path.join(scenarioDir, file)).href);
    await mod.default(ctx);
    const fatal = errors.filter((e) => !/favicon|GroupMarkerNotSet|GPU stall|swiftshader/i.test(e));
    if (fatal.length) throw new Error(`page errors:\n${fatal.join('\n')}`);
  } catch (e) {
    status = 'fail'; error = e && e.stack ? e.stack : String(e);
    try { await page.screenshot({ path: path.join(outDir, `${name}-FAIL.png`) }); } catch {}
  }
  fs.writeFileSync(path.join(outDir, `${name}.log`), logs.join('\n'));
  await context.close();
  results.push({ name, status, ms: Date.now() - t0, error, shots: shots.length });
  console.log(`${status === 'pass' ? 'PASS' : 'FAIL'} ${name} (${Date.now() - t0} ms, ${shots.length} shots)`);
  if (error) console.log(error.split('\n').slice(0, 12).map((l) => '    ' + l).join('\n'));
}

await browser.close();
server.close();
fs.writeFileSync(path.join(outDir, 'results.json'), JSON.stringify(results, null, 2));
const failed = results.filter((r) => r.status !== 'pass').length;
console.log(`\n${results.length - failed}/${results.length} scenarios passed; screenshots in ${path.relative(root, outDir)}/`);
process.exit(failed ? 1 : 0);
