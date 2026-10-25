// Size gate (§14.2): app.js ≤ 1024 KB minified and ≤ 300 KB gzip.
import fs from 'node:fs'; import zlib from 'node:zlib'; import path from 'node:path';
const file = path.resolve('dist/app.js');
if (!fs.existsSync(file)) { console.error('dist/app.js missing — run npm run build'); process.exit(2); }
const buf = fs.readFileSync(file); const gz = zlib.gzipSync(buf, { level: 9 }).length;
const kb = (n) => (n / 1024).toFixed(0);
console.log(`app.js ${kb(buf.length)} KB min, ${kb(gz)} KB gzip (limits 1024 / 300)`);
if (buf.length > 1024 * 1024 || gz > 300 * 1024) { console.error('size gate FAILED'); process.exit(1); }
