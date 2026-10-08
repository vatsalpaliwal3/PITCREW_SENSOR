// Mock backend that enforces the parts of the contract the sensor app touches.
import { createServer } from 'node:http';
import { UUID_V4_RE } from '../src/lib/uuid.js';

const FIELDS = ['client_event_id', 'device_id', 'lat', 'lng', 'peak_z_deviation', 'duration_ms', 'speed_kmh', 'recorded_at'];
const ALLOWED_HEADERS = ['content-type', 'x-request-id', 'x-sensor-key', 'x-admin-key', 'x-crew-key', 'x-test-run'];

export function startMock({ key = 'k-test', origin = 'https://sensor.example' } = {}) {
  const st = { events: new Map(), requests: [], failNext: 0, rateLimit: false, serverDown: false };
  const server = createServer(async (req, res) => {
    const cors = { 'Access-Control-Allow-Origin': origin, 'Access-Control-Expose-Headers': 'X-Request-ID,X-API-Version,Retry-After', 'X-API-Version': '1.1.0' };
    const send = (code, obj, extra = {}) => {
      res.writeHead(code, { 'Content-Type': 'application/json', ...cors, ...extra });
      res.end(JSON.stringify(obj));
    };
    const err = (code, c, m, extra) => send(code, { error: { code: c, message: m, details: null, request_id: 'r' } }, extra);

    if (req.method === 'OPTIONS') {
      const asked = String(req.headers['access-control-request-headers'] || '').toLowerCase().split(',').map((s) => s.trim()).filter(Boolean);
      const bad = asked.filter((h) => !ALLOWED_HEADERS.includes(h));
      if (bad.length) { res.writeHead(400); return res.end('preflight blocked: ' + bad.join()); }
      res.writeHead(204, { ...cors, 'Access-Control-Allow-Methods': 'GET,POST,PATCH,DELETE,OPTIONS', 'Access-Control-Allow-Headers': asked.join(',') });
      return res.end();
    }
    let raw = '';
    for await (const c of req) raw += c;
    const url = new URL(req.url, 'http://x');
    st.requests.push({ method: req.method, path: url.pathname, headers: req.headers, body: raw });
    if (st.serverDown) return err(503, 'DB_UNAVAILABLE', 'down');

    if (url.pathname === '/health') return send(200, { status: 'ok', version: '1.1.0', time: new Date().toISOString() });
    if (url.pathname === '/v1/config') return send(200, { MIN_PEAK_Z_DEVIATION: 3.0, GRAVITY_MS2: 9.81, BATCH_MAX_EVENTS: 200 });
    if (!url.pathname.startsWith('/v1/sensor-events')) return err(404, 'NOT_FOUND', 'nope');
    if (req.headers['x-sensor-key'] !== key) return err(401, 'UNAUTHORIZED', 'bad key');
    if (st.rateLimit) return err(429, 'RATE_LIMITED', 'slow down', { 'Retry-After': '2' });
    if (st.failNext > 0) { st.failNext--; return err(503, 'DB_UNAVAILABLE', 'try later'); }

    const validate = (e) => {
      const keys = Object.keys(e || {});
      if (keys.length !== FIELDS.length || !FIELDS.every((f) => keys.includes(f))) return ['VALIDATION_ERROR', 'unknown or missing field'];
      if (!UUID_V4_RE.test(e.client_event_id) || !UUID_V4_RE.test(e.device_id)) return ['VALIDATION_ERROR', 'uuid'];
      if (!(e.peak_z_deviation >= 3.0)) return ['VALIDATION_ERROR', 'peak below minimum'];
      if (!Number.isInteger(e.duration_ms) || e.duration_ms <= 0) return ['VALIDATION_ERROR', 'duration'];
      if (!(e.speed_kmh >= 0)) return ['VALIDATION_ERROR', 'speed'];
      if (!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/.test(e.recorded_at)) return ['VALIDATION_ERROR', 'recorded_at'];
      if (!(e.lat >= 26.7 && e.lat <= 26.9 && e.lng >= 75.7 && e.lng <= 75.95)) return ['OUTSIDE_SERVICE_AREA', 'outside'];
      return null;
    };
    const body = raw ? JSON.parse(raw) : {};
    if (url.pathname === '/v1/sensor-events' && req.method === 'POST') {
      const bad = validate(body);
      if (bad) return err(422, bad[0], bad[1]);
      const dup = st.events.has(body.client_event_id);
      st.events.set(body.client_event_id, body);
      return send(dup ? 200 : 201, { sensor_event: { id: 'x' }, pothole: { id: 'p' }, is_new_pothole: !dup });
    }
    if (url.pathname === '/v1/sensor-events/batch' && req.method === 'POST') {
      if (Object.keys(body).join() !== 'events' || !Array.isArray(body.events) || body.events.length > 200) return err(422, 'VALIDATION_ERROR', 'bad batch');
      let accepted = 0, duplicates = 0;
      const rejected = [];
      for (const e of body.events) {
        const bad = validate(e);
        if (bad) { rejected.push({ client_event_id: e?.client_event_id, code: bad[0], message: bad[1] }); continue; }
        if (st.events.has(e.client_event_id)) duplicates++; else accepted++;
        st.events.set(e.client_event_id, e);
      }
      return send(200, { accepted, duplicates, rejected });
    }
    return err(404, 'NOT_FOUND', 'nope');
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ st, server, base: `http://127.0.0.1:${server.address().port}`, close: () => server.close() })));
}
