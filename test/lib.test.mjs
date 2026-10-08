import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { UUID_V4_RE, uuidv4, deterministicUuid } from '../src/lib/uuid.js';
import { normalizeBaseUrl } from '../src/lib/url.js';
import { buildPayload, toIsoUtc } from '../src/lib/payload.js';
import { parseReplayCsv } from '../src/lib/csv.js';
import { replayToPayloads } from '../src/lib/replay.js';

test('uuid v4 lowercase and deterministic ids are v4-shaped and stable', async () => {
  assert.match(uuidv4(), UUID_V4_RE);
  const a = await deterministicUuid('x');
  assert.match(a, UUID_V4_RE);
  assert.equal(a, await deterministicUuid('x'));
  assert.notEqual(a, await deterministicUuid('y'));
});

test('normalizeBaseUrl', () => {
  assert.deepEqual(normalizeBaseUrl(''), { ok: true, value: '' });
  assert.equal(normalizeBaseUrl('https://api.example.org/').value, 'https://api.example.org');
  assert.equal(normalizeBaseUrl('https://api.example.org/v1/').value, 'https://api.example.org');
  assert.equal(normalizeBaseUrl('  https://api.example.org  ').value, 'https://api.example.org');
  assert.equal(normalizeBaseUrl('http://api.example.org').ok, false);
  assert.equal(normalizeBaseUrl('api.example.org').ok, false);
});

test('payload has exactly the 8 contract fields in contract formats', () => {
  const p = buildPayload({ eventId: uuidv4(), deviceId: uuidv4(), lat: 26.78912345, lng: 75.83401234, peak: 5.12349, durationMs: 120, speedKmh: 31.23456, recordedAtMs: Date.UTC(2026, 9, 8, 9, 30, 0, 123) });
  assert.deepEqual(Object.keys(p).sort(), ['client_event_id', 'device_id', 'duration_ms', 'lat', 'lng', 'peak_z_deviation', 'recorded_at', 'speed_kmh']);
  assert.equal(p.recorded_at, '2026-10-08T09:30:00Z');
  assert.equal(p.lat, 26.789123);
  assert.equal(p.peak_z_deviation, 5.123);
  assert.equal(toIsoUtc(0), '1970-01-01T00:00:00Z');
});

test('payload validation rejects out-of-contract values', () => {
  const ok = { eventId: uuidv4(), deviceId: uuidv4(), lat: 26.7, lng: 75.8, peak: 4, durationMs: 100, speedKmh: 10, recordedAtMs: 0 };
  assert.throws(() => buildPayload({ ...ok, peak: 2.9 }));
  assert.throws(() => buildPayload({ ...ok, durationMs: 0 }));
  assert.throws(() => buildPayload({ ...ok, speedKmh: -1 }));
  assert.throws(() => buildPayload({ ...ok, lat: 91 }));
  assert.throws(() => buildPayload({ ...ok, eventId: 'nope' }));
});

test('csv parser handles BOM, CRLF, bad rows, missing columns', () => {
  const good = '\uFEFFrecorded_at,lat,lng,x,y,z,speed_kmh\r\n2026-10-08T09:30:00.000Z,26.78,75.83,0.1,0.2,9.8,30\r\nbad,row\r\n';
  const r = parseReplayCsv(good);
  assert.equal(r.rows.length, 1);
  assert.equal(r.errors.length, 1);
  assert.ok(parseReplayCsv('a,b,c\n1,2,3').errors[0].includes('Missing column'));
  assert.equal(parseReplayCsv('').rows.length, 0);
});

test('bundled replay_drive.csv yields the 6 above-threshold bumps, skips the 2.0 one, and is idempotent', async () => {
  const text = await readFile(new URL('../src/replay_drive.csv', import.meta.url), 'utf8');
  const { rows, errors } = parseReplayCsv(text);
  assert.equal(errors.length, 0);
  assert.equal(rows.length, 1500);
  const dev = uuidv4();
  const a = await replayToPayloads(rows, { deviceId: dev });
  assert.equal(a.payloads.length, 6);
  assert.ok(a.payloads.every((p) => p.peak_z_deviation >= 3.0 && p.duration_ms > 0));
  const b = await replayToPayloads(rows, { deviceId: dev });
  assert.deepEqual(a.payloads.map((p) => p.client_event_id), b.payloads.map((p) => p.client_event_id));
  // speed gate: one bump is at ~10 km/h, still >= 5, so nothing is gated
  const gated = await replayToPayloads(rows, { deviceId: dev, demoMode: false });
  assert.equal(gated.payloads.length, 6);
  // orientation modes agree for a flat recording
  const flat = await replayToPayloads(rows, { deviceId: dev, detectorOptions: { mode: 'flat' } });
  assert.equal(flat.payloads.length, 6);
});
