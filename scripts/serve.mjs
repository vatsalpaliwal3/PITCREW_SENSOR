// Tiny static server for trying dist/ (or src/) locally. Usage: node scripts/serve.mjs [dir] [port]
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
// Apply the same security headers Vercel will send (from vercel.json) so CSP problems show up locally.
const vj = JSON.parse(await readFile(new URL('../vercel.json', import.meta.url), 'utf8'));
const hdrs = Object.fromEntries(vj.headers.filter((h) => h.source === '/(.*)').flatMap((h) => h.headers.map((x) => [x.key, x.value])));
const dir = process.argv[2] || 'dist';
const port = Number(process.argv[3] || process.env.PORT || 4173);
const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.csv': 'text/csv' };
createServer(async (req, res) => {
  const p = new URL(req.url, 'http://x').pathname;
  const file = join(dir, normalize(p === '/' ? '/index.html' : p).replace(/^(\.\.[/\\])+/, ''));
  try {
    res.writeHead(200, { ...hdrs, 'Content-Type': types[extname(file)] || 'application/octet-stream' });
    res.end(await readFile(file));
  } catch {
    res.writeHead(404).end('not found');
  }
}).listen(port, () => console.log(`serving ${dir} on port ${port}`));
