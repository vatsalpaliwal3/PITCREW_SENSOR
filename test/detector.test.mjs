import test from 'node:test';
import assert from 'node:assert/strict';
import { BumpDetector } from '../src/lib/detector.js';

const G = 9.81;
// Rotate the gravity vector into different phone orientations.
const orientations = {
  flat: [0, 0, G],
  upright: [0, G, 0],
  landscape: [G, 0, 0],
  tilted: [0, G * Math.sin(0.6), G * Math.cos(0.6)],
  upsideDown: [0, 0, -G],
};

function run(det, g, { seconds, hz = 50, bumps = [] }) {
  const events = [];
  const n = seconds * hz;
  const gm = Math.hypot(...g);
  const u = g.map((v) => v / gm);
  for (let i = 0; i < n; i++) {
    const t = (i * 1000) / hz;
    let extra = 0;
    for (const b of bumps) if (t >= b.at && t < b.at + (b.len ?? 100)) extra = b.mag;
    const noise = Math.sin(i * 1.7) * 0.15;
    const a = g.map((v, k) => v + u[k] * (extra + noise));
    const r = det.push({ t, x: a[0], y: a[1], z: a[2], ctx: { i } });
    if (r.event) events.push(r.event);
  }
  const f = det.flush();
  if (f) events.push(f);
  return events;
}

for (const [name, g] of Object.entries(orientations)) {
  test(`no false positives at rest (${name})`, () => {
    assert.equal(run(new BumpDetector(), g, { seconds: 10 }).length, 0);
  });
  test(`detects a bump regardless of orientation (${name})`, () => {
    const ev = run(new BumpDetector(), g, { seconds: 6, bumps: [{ at: 3000, mag: 6 }] });
    assert.equal(ev.length, 1);
    assert.ok(ev[0].peak >= 5.5 && ev[0].peak <= 6.6, `peak ${ev[0].peak}`);
  });
}

test('flat mode equals abs(z - 9.81)', () => {
  const d = new BumpDetector({ mode: 'flat' });
  const r = d.push({ t: 0, x: 0, y: 0, z: 14.81 });
  assert.ok(Math.abs(r.deviation - 5) < 1e-9);
});

test('spike below the 3.0 threshold is ignored; 3.0 exactly fires', () => {
  assert.equal(run(new BumpDetector({ mode: 'flat' }), [0, 0, G], { seconds: 4, bumps: [{ at: 1000, mag: 2.5 }] }).length, 0);
  const ev = run(new BumpDetector({ mode: 'flat' }), [0, 0, G], { seconds: 4, bumps: [{ at: 1000, mag: 3.2 }] });
  assert.equal(ev.length, 1);
  assert.ok(ev[0].peak >= 3.0);
});

test('cooldown merges bumps closer than 1.5 s, separates later ones', () => {
  const close = run(new BumpDetector(), [0, 0, G], { seconds: 8, bumps: [{ at: 2000, mag: 6 }, { at: 2800, mag: 6 }] });
  assert.equal(close.length, 1);
  const far = run(new BumpDetector(), [0, 0, G], { seconds: 8, bumps: [{ at: 2000, mag: 6 }, { at: 4500, mag: 6 }] });
  assert.equal(far.length, 2);
});

test('duration_ms is a positive integer and tracks the spike length', () => {
  const ev = run(new BumpDetector(), [0, 0, G], { seconds: 5, bumps: [{ at: 2000, mag: 6, len: 200 }] });
  assert.equal(ev.length, 1);
  assert.ok(Number.isInteger(ev[0].durationMs) && ev[0].durationMs >= 150 && ev[0].durationMs <= 320, `d=${ev[0].durationMs}`);
});

test('re-orienting the phone slowly does not fire', () => {
  const det = new BumpDetector();
  let fired = 0;
  for (let i = 0; i < 50 * 8; i++) {
    const ang = Math.min(1.5, (i / 50) * 0.4); // rotate to ~86 degrees over 4 s
    const r = det.push({ t: i * 20, x: 0, y: G * Math.sin(ang), z: G * Math.cos(ang) });
    if (r.event) fired++;
  }
  assert.equal(fired, 0);
});

test('pending spike is delivered by flush()', () => {
  const det = new BumpDetector({ mode: 'flat' });
  det.push({ t: 0, x: 0, y: 0, z: G });
  det.push({ t: 20, x: 0, y: 0, z: G + 6 });
  assert.equal(det.flush().peak, 6);
});

test('garbage samples are skipped safely', () => {
  const det = new BumpDetector();
  assert.equal(det.push({ t: 0, x: NaN, y: 0, z: 0 }).event, null);
  assert.equal(det.push({ t: 10, x: 0, y: 0, z: 0 }).deviation, null); // free fall
});
