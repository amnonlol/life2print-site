// Local preview of site/, served the way GitHub Pages serves a project site: under /life2print-site/.
// The live site is at the root of www.figureit.co.il once the domain is connected, and under /life2print-site/ until
// then; serving at / would let an absolute path ('/styles.css') work here and break only on the github.io address.
// No dependencies, no caching. Run: npm start (PORT to change the port).

import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SITE_DIR = fileURLToPath(new URL('../site/', import.meta.url)); // ends with a separator
const BASE = '/life2print-site/';
const PORT = Number(process.env.PORT) || 8080;

// Anything else is a 404, so a file type Pages would serve differently shows up here first.
const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
};

function send(res, status, body, headers = {}) {
  res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8', ...headers });
  res.end(body);
}

async function handle(req, res) {
  if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, 'Method not allowed', { Allow: 'GET, HEAD' });

  const url = new URL(req.url, 'http://localhost');
  // Keep the query string, so /?paid lands on /life2print-site/?paid like Grow's thank-you redirect.
  if (url.pathname === '/' || url.pathname === BASE.slice(0, -1)) {
    return send(res, 302, '', { Location: BASE + url.search });
  }
  if (!url.pathname.startsWith(BASE)) return send(res, 404, 'Not found');

  let relative;
  try {
    relative = decodeURIComponent(url.pathname.slice(BASE.length));
  } catch {
    return send(res, 400, 'Bad request');
  }
  if (relative === '' || relative.endsWith('/')) relative += 'index.html';

  // Resolve, then check the result is still inside site/: this catches ../, encoded %2e%2e, backslashes and
  // absolute paths alike.
  const file = path.resolve(SITE_DIR, relative);
  const type = TYPES[path.extname(file).toLowerCase()];
  if (!file.startsWith(SITE_DIR) || !type) return send(res, 404, 'Not found');

  let body;
  try {
    body = await fs.readFile(file);
  } catch {
    return send(res, 404, 'Not found');
  }
  res.writeHead(200, { 'Content-Type': type, 'Content-Length': body.length, 'Cache-Control': 'no-cache' });
  res.end(req.method === 'HEAD' ? undefined : body);
}

const server = http.createServer((req, res) => {
  handle(req, res).catch((error) => {
    console.error(error);
    if (!res.headersSent) send(res, 500, 'Server error');
  });
});

server.on('error', (error) => {
  console.error(error.code === 'EADDRINUSE' ? `Port ${PORT} is in use; set PORT to another one.` : error.message);
  process.exit(1);
});

server.listen(PORT, () => console.log(`Serving site/ at http://localhost:${PORT}${BASE}`));
