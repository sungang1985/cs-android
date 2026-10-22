// Copies the built web app (dist/) into the Android project's assets so Gradle can package it.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dist = path.join(root, 'dist');
const target = path.join(root, 'android', 'app', 'src', 'main', 'assets', 'www');

if (!fs.existsSync(path.join(dist, 'index.html'))) {
  console.error('dist/index.html not found. Run `npm run build` first.');
  process.exit(1);
}
fs.rmSync(target, { recursive: true, force: true });
fs.mkdirSync(target, { recursive: true });
fs.cpSync(dist, target, { recursive: true, filter: (src) => !src.endsWith('.map') });
const count = fs.readdirSync(target, { recursive: true }).length;
console.log(`[sync-android] copied ${count} entries to ${path.relative(root, target)}`);
