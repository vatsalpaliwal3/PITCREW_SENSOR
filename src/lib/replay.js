// Runs the SAME detector over a parsed replay CSV and returns finished events.
import { BumpDetector } from './detector.js';
import { buildPayload } from './payload.js';
import { deterministicUuid } from './uuid.js';

export const MIN_GATE_SPEED_KMH = 5;

export async function replayToPayloads(rows, { deviceId, detectorOptions = {}, demoMode = true, minPeak = 3.0 }) {
  const det = new BumpDetector(detectorOptions);
  const found = [];
  const collect = (ev) => {
    if (ev) found.push(ev);
  };
  for (const r of rows) {
    const { event } = det.push({ t: r.t, x: r.x, y: r.y, z: r.z, ctx: { wallMs: r.t, lat: r.lat, lng: r.lng, speedKmh: r.speedKmh } });
    collect(event);
  }
  collect(det.flush());

  const payloads = [];
  let ignoredSlow = 0;
  for (const ev of found) {
    if (!demoMode && ev.ctx.speedKmh < MIN_GATE_SPEED_KMH) {
      ignoredSlow++;
      continue;
    }
    const eventId = await deterministicUuid(`${deviceId}|${ev.ctx.wallMs}|${ev.ctx.lat}|${ev.ctx.lng}`);
    payloads.push(
      buildPayload(
        { eventId, deviceId, lat: ev.ctx.lat, lng: ev.ctx.lng, peak: ev.peak, durationMs: ev.durationMs, speedKmh: ev.ctx.speedKmh, recordedAtMs: ev.ctx.wallMs },
        { minPeak },
      ),
    );
  }
  return { payloads, detected: found.length, ignoredSlow, samples: rows.length };
}
