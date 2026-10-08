import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { startMock } from './mock_server.mjs';
import { createApi } from '../src/lib/api.js';
import { Sender } from '../src/lib/sender.js';
import { buildPayload } from '../src/lib/payload.js';
import { uuidv4 } from '../src/lib/uuid.js';
import { parseReplayCsv } from '../src/lib/csv.js';
import { replayToPayloads } from '../src/lib/replay.js';

const mem = () => { const m = new Map(); return { get: (k, f) => (m.has(k) ? JSON.parse(m.get(k)) : f), set: (k, v) => m.set(k, JSON.stringify(v)), remove: (k) => m.delete(k) }; };
const mk = (over = {}) => buildPayload({ eventId: uuidv4(), deviceId: uuidv4(), lat: 26.789, lng: 75.834, peak: 5, durationMs: 100, speedKmh: 30, recordedAtMs: Date.now(), ...over });

async function setup(opts = {}) {
  const mock = await startMock(opts.mock);
  const keyRef = { v: opts.key ?? 'k-test' };
  const api = createApi({ getBaseUrl: () => mock.base, getKey: () => keyRef.v, nextTimeoutMs: 3000, firstTimeoutMs: 3000 });
  const statuses = [];
  const sender = new Sender({ api, store: mem(), onStatus: (id, s) => statuses.push([id, s]) });
  return { mock, api, sender, statuses, keyRef };
}

test('health + config round trip', async () => {
  const { mock, api } = await setup();
  const h = await api.health(true);
  assert.equal(h.data.version, '1.1.0');
  assert.equal(h.apiVersion, '1.1.0');
  assert.equal((await api.config()).data.MIN_PEAK_Z_DEVIATION, 3);
  mock.close();
});

test('single event: 201 then 200 duplicate, key header sent, preflight-safe headers only', async () => {
  const { mock, sender } = await setup();
  const p = mk();
  assert.equal(await sender.submit(p), 'sent');
  assert.equal(await sender.submit(p), 'duplicate');
  const req = mock.st.requests.find((r) => r.path === '/v1/sensor-events');
  assert.equal(req.headers['x-sensor-key'], 'k-test');
  assert.equal(req.headers['content-type'], 'application/json');
  mock.close();
});

test('wrong key => queued and halted (401), recovers after key fixed', async () => {
  const { mock, sender, keyRef } = await setup({ key: 'wrong' });
  assert.equal(await sender.submit(mk()), 'queued');
  assert.equal(sender.authFailed, true);
  assert.equal((await sender.flush()).blocked, 'auth');
  keyRef.v = 'k-test';
  sender.clearAuthFailure();
  const r = await sender.flush();
  assert.equal(r.sent, 1);
  assert.equal(sender.size, 0);
  mock.close();
});

test('server down => queued; later flush goes through the batch endpoint in order', async () => {
  const { mock, sender } = await setup();
  mock.st.serverDown = true;
  const ps = [mk(), mk(), mk()];
  for (const p of ps) assert.equal(await sender.submit(p), 'queued');
  assert.equal(sender.size, 3);
  mock.st.serverDown = false;
  const r = await sender.flush();
  assert.deepEqual([r.sent, r.dropped, r.remaining], [3, 0, 0]);
  assert.ok(mock.st.requests.some((x) => x.path === '/v1/sensor-events/batch'));
  assert.equal(mock.st.events.size, 3);
  mock.close();
});

test('422 (outside service area) is dropped, not retried forever', async () => {
  const { mock, sender } = await setup();
  assert.equal(await sender.submit(mk({ lat: 12.9, lng: 77.5 })), 'rejected');
  assert.equal(sender.size, 0);
  mock.close();
});

test('batch rejects only the bad event; the rest are accepted', async () => {
  const { mock, sender } = await setup();
  mock.st.serverDown = true;
  await sender.submit(mk());
  await sender.submit(mk({ lat: 12.9, lng: 77.5 }));
  await sender.submit(mk());
  mock.st.serverDown = false;
  const r = await sender.flush();
  assert.deepEqual([r.sent, r.dropped, r.remaining], [2, 1, 0]);
  mock.close();
});

test('429 pauses sending, keeps the event, and resumes after Retry-After', async () => {
  const { mock, sender } = await setup();
  mock.st.rateLimit = true;
  assert.equal(await sender.submit(mk()), 'queued');
  assert.ok(sender.pausedUntil > Date.now());
  assert.equal((await sender.flush()).blocked, 'ratelimit');
  mock.st.rateLimit = false;
  sender.pausedUntil = 0;
  assert.equal((await sender.flush()).sent, 1);
  mock.close();
});

test('network failure (nothing listening) queues the event', async () => {
  const api = createApi({ getBaseUrl: () => 'http://127.0.0.1:1', getKey: () => 'k', firstTimeoutMs: 1500 });
  const sender = new Sender({ api, store: mem() });
  assert.equal(await sender.submit(mk()), 'queued');
  assert.equal(sender.size, 1);
});

test('missing base url / key raise clear config errors', async () => {
  const api = createApi({ getBaseUrl: () => '', getKey: () => '' });
  await assert.rejects(api.health(), /API base URL/);
  const api2 = createApi({ getBaseUrl: () => 'https://x.example', getKey: () => '' });
  await assert.rejects(api2.postEvent({}), /Sensor key/);
});

test('end to end replay: bundled CSV -> batch -> 6 new, second run all known', async () => {
  const { mock, sender } = await setup();
  const { rows } = parseReplayCsv(await readFile(new URL('../src/replay_drive.csv', import.meta.url), 'utf8'));
  const { payloads } = await replayToPayloads(rows, { deviceId: uuidv4() });
  const a = await sender.sendBatchDirect(payloads);
  assert.deepEqual([a.accepted, a.duplicates, a.rejected.length], [6, 0, 0]);
  const b = await sender.sendBatchDirect(payloads);
  assert.deepEqual([b.accepted, b.duplicates], [0, 6]);
  mock.close();
});

test('replay with server down parks events in the queue instead of losing them', async () => {
  const { mock, sender } = await setup();
  mock.st.serverDown = true;
  const out = await sender.sendBatchDirect([mk(), mk()]);
  assert.equal(out.queued, 2);
  assert.equal(sender.size, 2);
  mock.close();
});
