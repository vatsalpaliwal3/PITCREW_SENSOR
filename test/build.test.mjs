import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFile, access } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const build = (env) => spawnSync('node', ['scripts/build.mjs'], { cwd: root, env: { PATH: process.env.PATH, ...env }, encoding: 'utf8' });

test('build writes env.js from API_BASE_URL and SENSOR_KEY and copies every asset', async () => {
  const r = build({ API_BASE_URL: 'https://api.example.org/v1/', SENSOR_KEY: 'abc"</script>' });
  assert.equal(r.status, 0, r.stderr);
  const env = await readFile(root + 'dist/env.js', 'utf8');
  assert.ok(env.includes('"API_BASE_URL":"https://api.example.org"'));
  assert.ok(!env.includes('</script>'), 'must be script-safe');
  for (const f of ['index.html', 'app.js', 'styles.css', 'replay_drive.csv', 'favicon.svg', 'lib/detector.js', 'lib/sender.js']) await access(root + 'dist/' + f);
});

test('build does not fail when env is missing (app has a Settings panel) but warns', () => {
  const r = build({});
  assert.equal(r.status, 0);
  assert.match(r.stderr + r.stdout, /not set/);
});

test('build fails loudly on an http:// URL', () => {
  const r = build({ API_BASE_URL: 'http://api.example.org' });
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /https/);
});
