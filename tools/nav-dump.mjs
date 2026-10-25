// Wrapper for tools/nav-dump.ts: bundles it on the fly with esbuild (in memory) and runs it.
// Usage: node tools/nav-dump.mjs [--training] [--cover] [--map box]
import esbuild from 'esbuild';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const result = await esbuild.build({
  entryPoints: [path.join(root, 'tools/nav-dump.ts')],
  bundle: true, platform: 'node', format: 'esm', target: 'node22', write: false, logLevel: 'error',
});
const code = result.outputFiles[0].text;
const mod = await import('data:text/javascript;base64,' + Buffer.from(code).toString('base64'));
mod.main(process.argv.slice(2));
