// The game server's plain-HTTP side. The WebSocket upgrade rides on the same port.
//
//  GET /healthz   200 + a little JSON while the server is up (for container health checks)
//  anything else  the built website from STATIC_DIR, if set, so one container can host both the
//                 site and the game on a single origin; 404 otherwise
//
// Static files: no directory listings, no paths outside STATIC_DIR, long cache headers for Vite's
// content-hashed files under /assets/, no caching for index.html.

import { createReadStream, statSync } from 'node:fs';
import { extname, join, normalize, resolve, sep } from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.glb': 'model/gltf-binary',
  '.wasm': 'application/wasm',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
};

const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
};

export function makeHttpHandler(opts: { staticDir: string | null; health: () => Record<string, unknown> }) {
  const root = opts.staticDir ? resolve(opts.staticDir) : null;

  return (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (url.pathname === '/healthz') {
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...SECURITY_HEADERS });
      res.end(JSON.stringify({ ok: true, ...opts.health() }));
      return;
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405, { Allow: 'GET, HEAD', ...SECURITY_HEADERS }).end();
      return;
    }
    if (!root) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8', ...SECURITY_HEADERS }).end('Not found\n');
      return;
    }

    let rel: string;
    try {
      rel = decodeURIComponent(url.pathname);
    } catch {
      res.writeHead(400, SECURITY_HEADERS).end();
      return;
    }
    if (rel.includes('\0')) {
      res.writeHead(400, SECURITY_HEADERS).end();
      return;
    }
    if (rel.endsWith('/')) rel += 'index.html';
    const file = resolve(join(root, normalize(rel)));
    if (file !== root && !file.startsWith(root + sep)) {
      res.writeHead(403, SECURITY_HEADERS).end(); // tried to climb out of STATIC_DIR
      return;
    }
    let size: number;
    try {
      const st = statSync(file);
      if (!st.isFile()) throw new Error('not a file');
      size = st.size;
    } catch {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8', ...SECURITY_HEADERS }).end('Not found\n');
      return;
    }
    const hashed = rel.startsWith('/assets/');
    res.writeHead(200, {
      'Content-Type': TYPES[extname(file).toLowerCase()] ?? 'application/octet-stream',
      'Content-Length': size,
      'Cache-Control': hashed ? 'public, max-age=31536000, immutable' : 'no-cache',
      ...SECURITY_HEADERS,
    });
    if (req.method === 'HEAD') {
      res.end();
      return;
    }
    createReadStream(file).pipe(res);
  };
}
