#!/usr/bin/env node
/**
 * Wrapper for tools/balance-sim.ts (named differently so module resolution of `tools/balance-sim` keeps finding the .ts): bundles it (and the pure src/ modules it imports) with esbuild into a temporary
 * ESM file, imports it and runs main(argv). Usage: node tools/balance.mjs [--matches 20] [--difficulty all] [--team 5] [--rounds 6] [--cap 54000]
 */
import { build } from 'esbuild';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';

const here = path.dirname(fileURLToPath(import.meta.url));
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-balance-'));
const out = path.join(dir, 'balance-sim.mjs');
try {
  await build({ entryPoints: [path.join(here, 'balance-sim.ts')], bundle: true, platform: 'node', format: 'esm', target: 'node22', outfile: out, logLevel: 'warning' });
  const mod = await import(pathToFileURL(out).href);
  process.exitCode = mod.main(process.argv.slice(2));
} finally {
  fs.rmSync(dir, { recursive: true, force: true });
}
