// Tiny static file server for dist/ (dev + e2e). Usage: node tools/serve.mjs [port] [dir]
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.webmanifest': 'application/manifest+json',
  '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.map': 'application/json', '.txt': 'text/plain',
};

export function createStaticServer(dir) {
  return http.createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    let p = path.normalize(path.join(dir, decodeURIComponent(url.pathname)));
    if (!p.startsWith(dir)) { res.statusCode = 403; res.end(); return; }
    if (fs.existsSync(p) && fs.statSync(p).isDirectory()) p = path.join(p, 'index.html');
    if (!fs.existsSync(p)) { res.statusCode = 404; res.end('not found'); return; }
    res.setHeader('content-type', MIME[path.extname(p)] || 'application/octet-stream');
    res.setHeader('cache-control', 'no-store');
    res.end(fs.readFileSync(p));
  });
}

export function startServer(dir, port = 0) {
  return new Promise((resolve) => {
    const srv = createStaticServer(dir);
    srv.listen(port, '127.0.0.1', () => resolve({ server: srv, port: srv.address().port, url: `http://127.0.0.1:${srv.address().port}/` }));
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const port = Number(process.argv[2] || 8080);
  const dir = path.resolve(process.argv[3] || 'dist');
  startServer(dir, port).then(({ url }) => console.log(`serving ${dir} at ${url}`));
}
