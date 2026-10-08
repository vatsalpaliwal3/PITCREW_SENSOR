// Builds the exact SensorEvent client fields from constitution 5.4 / 8.1.
// The server rejects unknown fields with 422, so this returns these 8 keys and nothing else.
import { UUID_V4_RE } from './uuid.js';

const round6 = (v) => Math.round(v * 1e6) / 1e6;
const round3 = (v) => Math.round(v * 1000) / 1000;

export function toIsoUtc(ms) {
  return new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z'); // 2026-10-08T09:30:00Z
}

export function buildPayload({ eventId, deviceId, lat, lng, peak, durationMs, speedKmh, recordedAtMs }, { minPeak = 3.0 } = {}) {
  if (!UUID_V4_RE.test(eventId)) throw new Error('client_event_id must be a UUID v4');
  if (!UUID_V4_RE.test(deviceId)) throw new Error('device_id must be a UUID v4');
  if (!(Number.isFinite(lat) && lat >= -90 && lat <= 90)) throw new Error('lat out of range');
  if (!(Number.isFinite(lng) && lng >= -180 && lng <= 180)) throw new Error('lng out of range');
  if (!(Number.isFinite(peak) && round3(peak) >= minPeak)) throw new Error('peak_z_deviation below minimum');
  if (!(Number.isInteger(durationMs) && durationMs > 0)) throw new Error('duration_ms must be a positive integer');
  if (!(Number.isFinite(speedKmh) && speedKmh >= 0)) throw new Error('speed_kmh must be >= 0');
  if (!Number.isFinite(recordedAtMs)) throw new Error('recorded_at invalid');
  return {
    client_event_id: eventId,
    device_id: deviceId,
    lat: round6(lat),
    lng: round6(lng),
    peak_z_deviation: round3(peak),
    duration_ms: durationMs,
    speed_kmh: round3(speedKmh),
    recorded_at: toIsoUtc(recordedAtMs),
  };
}
