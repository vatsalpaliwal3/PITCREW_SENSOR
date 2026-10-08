// Vercel build: copy src/ to dist/ and write dist/env.js from environment variables.
// No URL literals live in source (constitution 12.1); the API URL arrives as API_BASE_URL.
import { cp, mkdir, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { normalizeBaseUrl } from '../src/lib/url.js';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const dist = join(root, 'dist');

const url = normalizeBaseUrl(process.env.API_BASE_URL);
if (!url.ok) {
  console.error(`\nBUILD ERROR: API_BASE_URL is invalid: ${url.error}\n  Got: ${process.env.API_BASE_URL}\n`);
  process.exit(1);
}
const key = (process.env.SENSOR_KEY || '').trim();

await rm(dist, { recursive: true, force: true });
await mkdir(dist, { recursive: true });
await cp(join(root, 'src'), dist, { recursive: true });

const env = { API_BASE_URL: url.value, SENSOR_KEY: key, BUILT_AT: new Date().toISOString() };
const js = `window.__SENSOR_ENV__ = Object.freeze(${JSON.stringify(env).replace(/</g, '\\u003c')});\n`;
await writeFile(join(dist, 'env.js'), js);

console.log(`sensor-app built -> dist/`);
console.log(`  API_BASE_URL: ${url.value || '(not set: users must enter it in Settings)'}`);
console.log(`  SENSOR_KEY:   ${key ? '(set)' : '(not set: users must enter it in Settings)'}`);
if (!url.value) console.warn('  WARNING: API_BASE_URL is empty. Set it in Vercel > Settings > Environment Variables and redeploy.');
