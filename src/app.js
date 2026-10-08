// Sensor web app UI (constitution section 11). All dynamic text is set with textContent, never innerHTML.
import { BumpDetector, DEFAULTS } from './lib/detector.js';
import { createApi } from './lib/api.js';
import { Sender } from './lib/sender.js';
import { store } from './lib/storage.js';
import { uuidv4 } from './lib/uuid.js';
import { buildPayload } from './lib/payload.js';
import { normalizeBaseUrl } from './lib/url.js';
import { parseReplayCsv } from './lib/csv.js';
import { replayToPayloads, MIN_GATE_SPEED_KMH } from './lib/replay.js';

const $ = (id) => document.getElementById(id);
const ENV = window.__SENSOR_ENV__ || {};
const SETTINGS_KEY = 'sensor.settings';

// ---------- state ----------
const state = {
  running: false,
  threshold: DEFAULTS.threshold,
  gravity: DEFAULTS.gravity,
  batchMax: 200,
  configFromServer: false,
  pos: null, // { lat, lng, accuracy, speedKmh, at }
  counts: { detected: 0, sent: 0, rejected: 0 },
  samples: 0,
  lastPaint: 0,
  hzWindow: { start: 0, n: 0 },
  wakeLock: null,
  motionTimer: null,
  gotMotion: false,
  watchId: null,
};

// ---------- device id ----------
function getDeviceId(key) {
  let id = store.get(key, null);
  if (typeof id !== 'string' || !/^[0-9a-f-]{36}$/.test(id)) {
    id = uuidv4();
    store.set(key, id);
  }
  return id;
}
const deviceId = getDeviceId('sensor.device_id');
const replayDeviceId = getDeviceId('sensor.replay_device_id'); // replay counts as its own device

// ---------- settings ----------
function loadSettings() {
  const s = store.get(SETTINGS_KEY, {}) || {};
  return { apiUrl: s.apiUrl ?? '', key: s.key ?? '', demoMode: s.demoMode ?? true, mount: s.mount ?? 'auto' };
}
let settings = loadSettings();
const envUrl = normalizeBaseUrl(ENV.API_BASE_URL).value;
const effectiveUrl = () => normalizeBaseUrl(settings.apiUrl).value || envUrl;
const effectiveKey = () => settings.key || ENV.SENSOR_KEY || '';

// ---------- wiring ----------
const api = createApi({ getBaseUrl: effectiveUrl, getKey: effectiveKey });
const detector = new BumpDetector({ mode: settings.mount });
const sender = new Sender({
  api,
  batchMax: state.batchMax,
  onStatus: (id, status, detail) => updateLog(id, status, detail),
  onReply: (label, obj) => showReply(label, obj),
});

// ---------- tiny helpers ----------
function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}
const fmt = (v, d = 2) => (Number.isFinite(v) ? v.toFixed(d) : '–');
const clock = (ms = Date.now()) => new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });

const banners = new Map();
function setBanner(key, kind, html) {
  if (!html) banners.delete(key);
  else banners.set(key, { kind, ...html });
  const box = $('banners');
  box.replaceChildren();
  for (const [, b] of banners) {
    const d = el('div', `banner ${b.kind}`);
    if (b.title) d.append(el('b', '', b.title + ' '));
    d.append(document.createTextNode(b.text));
    box.append(d);
  }
}

function setConn(stateName, text) {
  $('conn').dataset.state = stateName;
  $('connText').textContent = text;
}

function showReply(label, obj) {
  let body;
  try {
    body = JSON.stringify(obj, null, 2);
  } catch {
    body = String(obj);
  }
  $('reply').textContent = `${clock()}  ${label}\n${body.length > 2000 ? body.slice(0, 2000) + '\n…' : body}`;
}

function note(id, text) {
  $(id).textContent = text || '';
}

// ---------- event log ----------
const logRows = new Map(); // client_event_id -> { li, st }
function addLog(id, label, status, extra) {
  const li = el('li');
  const left = el('span', 'lt', `${clock()}  ${label}`);
  const st = el('span', 'st', '');
  li.append(left, st);
  $('log').prepend(li);
  logRows.set(id, { li, st });
  while ($('log').children.length > 10) {
    const last = $('log').lastElementChild;
    for (const [k, v] of logRows) if (v.li === last) logRows.delete(k);
    last.remove();
  }
  setLogStatus(id, status, extra);
}
const STATUS_TEXT = { sending: 'sending…', sent: 'sent', duplicate: 'already known', queued: 'queued', rejected: 'rejected', ignored: 'ignored' };
function setLogStatus(id, status, extra) {
  const row = logRows.get(id);
  if (!row) return;
  row.st.dataset.s = status;
  row.st.textContent = STATUS_TEXT[status] + (extra && typeof extra === 'string' ? ` (${extra})` : '');
}
function updateLog(id, status, detail) {
  if (status === 'sent' || status === 'duplicate') state.counts.sent++;
  if (status === 'rejected') state.counts.rejected++;
  setLogStatus(id, status, typeof detail === 'string' ? detail : undefined);
  renderCounters();
}
function renderCounters() {
  $('cDet').textContent = state.counts.detected;
  $('cSent').textContent = state.counts.sent;
  $('cQueue').textContent = sender.size;
  $('cRej').textContent = state.counts.rejected;
}

// ---------- server config / health ----------
function findConst(obj, name) {
  if (!obj || typeof obj !== 'object') return undefined;
  const lower = name.toLowerCase();
  for (const [k, v] of Object.entries(obj)) {
    if (k.toLowerCase() === lower && typeof v === 'number') return v;
  }
  for (const v of Object.values(obj)) {
    if (v && typeof v === 'object') {
      const r = findConst(v, name);
      if (r !== undefined) return r;
    }
  }
  return undefined;
}

function applyThreshold() {
  detector.configure({ threshold: state.threshold, gravity: state.gravity });
  $('thrLabel').textContent = `threshold ${state.threshold.toFixed(1)}`;
  $('meterMark').style.left = `${Math.min(100, (state.threshold / 10) * 100)}%`;
}

async function checkServer({ deep = false } = {}) {
  if (!effectiveUrl()) {
    setConn('bad', 'Not configured');
    setBanner('config', 'warn', { title: 'API URL missing.', text: 'Open Settings and enter the backend HTTPS URL (or set API_BASE_URL in Vercel and redeploy).' });
    return false;
  }
  setBanner('config', 'warn', null);
  setConn('busy', api.isWarm() ? 'Checking…' : 'Waking server…');
  const slow = setTimeout(() => {
    if (!api.isWarm()) setBanner('wake', 'info', { title: 'Waking up the server.', text: 'The free tier can take up to a minute on the first request.' });
  }, 4000);
  try {
    const h = await api.health(deep);
    setConn('ok', `Online${h.data?.version ? ' · v' + h.data.version : ''}`);
    setBanner('net', 'bad', null);
    setBanner('cors', 'bad', null);
    try {
      const c = await api.config();
      const mp = findConst(c.data, 'MIN_PEAK_Z_DEVIATION');
      const g = findConst(c.data, 'GRAVITY_MS2');
      const bm = findConst(c.data, 'BATCH_MAX_EVENTS');
      if (mp > 0 && mp < 50) state.threshold = mp;
      if (g > 5 && g < 15) state.gravity = g;
      if (bm >= 1 && bm <= 1000) {
        state.batchMax = bm;
        sender.batchMax = bm;
      }
      state.configFromServer = mp !== undefined;
      applyThreshold();
      note('cfgNote', state.configFromServer ? `Thresholds loaded from the server (min deviation ${state.threshold} m/s²).` : 'Server config did not list the sensor constants; using defaults.');
    } catch {
      note('cfgNote', 'Could not load /v1/config; using default thresholds.');
    }
    if (sender.size > 0) flushQueue();
    return true;
  } catch (e) {
    setConn('bad', e.kind === 'timeout' ? 'Server not answering' : 'Cannot reach server');
    if (e.kind === 'network') {
      setBanner('cors', 'bad', { title: 'Cannot reach the server.', text: `Check the URL, your connection, and that ${location.origin} is in the backend ALLOWED_ORIGINS (exact origin, no trailing slash).` });
    } else {
      setBanner('cors', 'bad', { title: 'Server problem.', text: e.message });
    }
    return false;
  } finally {
    clearTimeout(slow);
    setBanner('wake', 'info', null);
  }
}

async function flushQueue() {
  if (sender.size === 0) return;
  const r = await sender.flush();
  if (r.blocked === 'auth') setBanner('auth', 'bad', { title: 'Sensor key rejected.', text: 'Events are being kept. Fix the key in Settings.' });
  renderCounters();
}

// ---------- detection → delivery ----------
function currentContext() {
  return state.pos ? { wallMs: Date.now(), lat: state.pos.lat, lng: state.pos.lng, speedKmh: state.pos.speedKmh } : { wallMs: Date.now(), lat: null, lng: null, speedKmh: 0 };
}

function handleEvent(ev) {
  state.counts.detected++;
  renderCounters();
  const ctx = ev.ctx;
  const label = `bump ${ev.peak.toFixed(1)} m/s²`;
  if (!Number.isFinite(ctx.lat) || !Number.isFinite(ctx.lng)) {
    addLog(uuidv4(), label, 'ignored', 'no GPS fix');
    return;
  }
  if (!settings.demoMode && ctx.speedKmh < MIN_GATE_SPEED_KMH) {
    addLog(uuidv4(), label, 'ignored', 'not moving');
    return;
  }
  send(ev, label);
}

function send(ev, label) {
  let payload;
  try {
    payload = buildPayload(
      { eventId: uuidv4(), deviceId, lat: ev.ctx.lat, lng: ev.ctx.lng, peak: ev.peak, durationMs: ev.durationMs, speedKmh: ev.ctx.speedKmh, recordedAtMs: ev.ctx.wallMs },
      { minPeak: state.threshold },
    );
  } catch (e) {
    addLog(uuidv4(), label, 'ignored', e.message);
    return;
  }
  addLog(payload.client_event_id, label, 'sending');
  sender.submit(payload).then(renderCounters);
}

// ---------- sensors ----------
function onMotion(e) {
  const a = e.accelerationIncludingGravity;
  if (!a || a.x == null || a.y == null || a.z == null) return;
  state.gotMotion = true;
  const now = performance.now();
  const r = detector.push({ t: now, x: a.x, y: a.y, z: a.z, ctx: currentContext() });
  state.samples++;
  if (!state.hzWindow.start) state.hzWindow.start = now;
  state.hzWindow.n++;
  if (r.event) handleEvent(r.event);
  if (now - state.lastPaint > 90) {
    state.lastPaint = now;
    $('vX').textContent = fmt(a.x);
    $('vY').textContent = fmt(a.y);
    $('vZ').textContent = fmt(a.z);
    $('vDev').textContent = fmt(r.deviation);
    const frac = Math.min(1, (r.deviation ?? 0) / 10);
    const fill = $('meterFill');
    fill.style.transform = `scaleX(${frac})`;
    fill.classList.toggle('hot', (r.deviation ?? 0) >= state.threshold);
    if (now - state.hzWindow.start >= 1000) {
      $('vHz').textContent = `${Math.round((state.hzWindow.n * 1000) / (now - state.hzWindow.start))} Hz`;
      state.hzWindow = { start: now, n: 0 };
    }
  }
}

function onPosition(p) {
  const c = p.coords;
  state.pos = { lat: c.latitude, lng: c.longitude, accuracy: c.accuracy, speedKmh: Math.max(0, (c.speed ?? 0) * 3.6), at: Date.now() };
  $('vSpeed').textContent = `${fmt(state.pos.speedKmh, 1)} km/h`;
  $('vAcc').textContent = `±${Math.round(c.accuracy)} m`;
  $('vPos').textContent = `${c.latitude.toFixed(6)}, ${c.longitude.toFixed(6)}`;
  setBanner('gps', 'warn', null);
}
function onPositionError(err) {
  const denied = err.code === 1;
  setBanner('gps', 'warn', { title: denied ? 'Location permission denied.' : 'No GPS fix yet.', text: denied ? 'Allow location for this site, otherwise events cannot be placed on the map.' : 'Go outside or near a window. Events are ignored until a fix arrives.' });
}

async function acquireWakeLock() {
  try {
    if ('wakeLock' in navigator) {
      state.wakeLock = await navigator.wakeLock.request('screen');
      state.wakeLock.addEventListener('release', () => (state.wakeLock = null));
    }
  } catch {
    /* not critical */
  }
}
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && state.running && !state.wakeLock) acquireWakeLock();
});

async function start() {
  if (!window.isSecureContext) {
    setBanner('secure', 'bad', { title: 'HTTPS required.', text: 'Sensors and GPS only work on a secure (https) page.' });
    return;
  }
  if (typeof window.DeviceMotionEvent === 'undefined') {
    setBanner('motion', 'bad', { title: 'No motion sensor API.', text: 'This browser does not expose the accelerometer. Use Chrome on an Android phone.' });
    return;
  }
  // iOS needs the permission call directly inside the tap handler, before any other await.
  if (typeof DeviceMotionEvent.requestPermission === 'function') {
    try {
      const res = await DeviceMotionEvent.requestPermission();
      if (res !== 'granted') {
        setBanner('motion', 'bad', { title: 'Motion permission denied.', text: 'Allow Motion & Orientation access for this site in your browser settings.' });
        return;
      }
    } catch {
      setBanner('motion', 'bad', { title: 'Motion permission failed.', text: 'Reload the page and tap Start again.' });
      return;
    }
  }
  setBanner('motion', 'bad', null);
  detector.reset();
  detector.configure({ mode: settings.mount, threshold: state.threshold, gravity: state.gravity });
  state.gotMotion = false;
  state.hzWindow = { start: 0, n: 0 };
  window.addEventListener('devicemotion', onMotion);
  if ('geolocation' in navigator) {
    state.watchId = navigator.geolocation.watchPosition(onPosition, onPositionError, { enableHighAccuracy: true, maximumAge: 1000, timeout: 20000 });
  }
  acquireWakeLock();
  state.running = true;
  paintRunState();
  state.motionTimer = setTimeout(() => {
    if (!state.gotMotion) setBanner('motion', 'bad', { title: 'No accelerometer data.', text: 'Desktops and some browsers have no accelerometer. Open this page on your phone.' });
  }, 2500);
}

function stop() {
  window.removeEventListener('devicemotion', onMotion);
  if (state.watchId !== null) navigator.geolocation.clearWatch(state.watchId);
  state.watchId = null;
  clearTimeout(state.motionTimer);
  try {
    state.wakeLock?.release();
  } catch {
    /* ignore */
  }
  state.wakeLock = null;
  const pending = detector.flush();
  if (pending) handleEvent(pending);
  state.running = false;
  $('meterFill').style.transform = 'scaleX(0)';
  paintRunState();
}

function paintRunState() {
  const on = state.running;
  const b = $('toggleBtn');
  b.textContent = on ? 'Stop detecting' : 'Start detecting';
  b.classList.toggle('stop', on);
  $('runState').textContent = on ? 'Listening' : 'Stopped';
  $('runState').dataset.on = String(on);
  $('hint').textContent = on ? 'Keep this screen open. The screen stays awake while detecting.' : 'Mount the phone in a holder with the screen on, then tap Start. Sensors and GPS need your permission.';
}

// ---------- actions ----------
function ensureReady() {
  if (!effectiveUrl()) {
    $('settings').open = true;
    note('actionNote', 'Set the API URL in Settings first.');
    return false;
  }
  if (!effectiveKey()) {
    $('settings').open = true;
    note('actionNote', 'Enter the sensor key in Settings first.');
    return false;
  }
  note('actionNote', '');
  return true;
}

function sendTest() {
  if (!ensureReady()) return;
  if (!state.pos) {
    note('actionNote', 'No GPS fix yet. Tap Start detecting and allow location, then try again. (Events outside the service area are rejected, so a fake location would not work.)');
    return;
  }
  state.counts.detected++;
  const ctx = { wallMs: Date.now(), lat: state.pos.lat, lng: state.pos.lng, speedKmh: state.pos.speedKmh };
  send({ peak: Math.max(5, state.threshold + 2), durationMs: 120, ctx }, 'test event');
}

async function runReplay(csvText, sourceLabel) {
  if (!ensureReady()) return;
  const btn = $('replayBtn');
  btn.disabled = true;
  note('actionNote', `Running ${sourceLabel}…`);
  try {
    const { rows, errors } = parseReplayCsv(csvText);
    if (rows.length === 0) {
      note('actionNote', errors[0] || 'No usable rows in the CSV.');
      return;
    }
    const res = await replayToPayloads(rows, {
      deviceId: replayDeviceId,
      demoMode: settings.demoMode,
      detectorOptions: { mode: settings.mount, threshold: state.threshold, gravity: state.gravity },
      minPeak: state.threshold,
    });
    state.counts.detected += res.detected;
    renderCounters();
    if (res.payloads.length === 0) {
      note('actionNote', `Replay found ${res.detected} bumps but none were sendable${res.ignoredSlow ? ' (slow speed gate; turn on Demo mode)' : ''}.`);
      return;
    }
    const out = await sender.sendBatchDirect(res.payloads);
    state.counts.sent += out.accepted + out.duplicates;
    state.counts.rejected += out.rejected.length;
    renderCounters();
    addLog(uuidv4(), `replay · ${res.payloads.length} bumps`, out.queued ? 'queued' : out.rejected.length ? 'rejected' : 'sent', `${out.accepted} new, ${out.duplicates} known${out.rejected.length ? ', ' + out.rejected.length + ' rejected' : ''}`);
    const skipped = errors.length ? ` ${errors.length}+ bad lines skipped.` : '';
    note('actionNote', `Replay done: ${res.detected} bumps detected in ${res.samples} samples → ${out.accepted} new, ${out.duplicates} already known, ${out.rejected.length} rejected${out.queued ? `, ${out.queued} queued for retry` : ''}.${skipped}`);
    if (out.rejected[0]) showReply('replay rejected (first)', out.rejected[0]);
  } catch (e) {
    note('actionNote', `Replay failed: ${e.message}`);
    if (e.status === 401 || e.status === 403) setBanner('auth', 'bad', { title: 'Sensor key rejected.', text: 'Fix the key in Settings.' });
  } finally {
    btn.disabled = false;
    renderCounters();
  }
}

async function replayBundled() {
  try {
    const r = await fetch('./replay_drive.csv', { cache: 'no-store' });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    await runReplay(await r.text(), 'replay drive');
  } catch (e) {
    note('actionNote', `Could not load replay_drive.csv (${e.message}).`);
  }
}

// ---------- settings UI ----------
function fillSettings() {
  $('apiUrl').value = settings.apiUrl || envUrl;
  $('sensorKey').value = settings.key || ENV.SENSOR_KEY || '';
  $('demoMode').checked = !!settings.demoMode;
  $('mount').value = settings.mount;
  $('origin').textContent = location.origin;
  $('deviceId').textContent = deviceId;
}

async function saveSettings() {
  const n = normalizeBaseUrl($('apiUrl').value);
  const help = $('apiUrlHelp');
  if (!n.ok) {
    help.textContent = n.error;
    help.className = 'bad';
    return;
  }
  help.textContent = 'HTTPS origin of the backend. No trailing slash, no /v1.';
  help.className = '';
  settings = {
    apiUrl: n.value === envUrl ? '' : n.value,
    key: $('sensorKey').value.trim() === (ENV.SENSOR_KEY || '') ? '' : $('sensorKey').value.trim(),
    demoMode: $('demoMode').checked,
    mount: $('mount').value,
  };
  store.set(SETTINGS_KEY, settings);
  detector.configure({ mode: settings.mount });
  sender.clearAuthFailure();
  setBanner('auth', 'bad', null);
  note('settingsNote', 'Saved. Testing connection…');
  const ok = await checkServer({ deep: true });
  note('settingsNote', ok ? 'Connected. Settings saved.' : 'Saved, but the server could not be reached yet.');
}

function resetSettings() {
  store.remove(SETTINGS_KEY);
  settings = loadSettings();
  fillSettings();
  note('settingsNote', 'Reset to the build defaults.');
  checkServer();
}

// ---------- boot ----------
function boot() {
  fillSettings();
  applyThreshold();
  paintRunState();
  renderCounters();

  $('toggleBtn').addEventListener('click', () => (state.running ? stop() : start()));
  $('testBtn').addEventListener('click', sendTest);
  $('replayBtn').addEventListener('click', replayBundled);
  $('csvBtn').addEventListener('click', () => $('csvInput').click());
  $('csvInput').addEventListener('change', async (e) => {
    const f = e.target.files?.[0];
    e.target.value = '';
    if (f) await runReplay(await f.text(), f.name);
  });
  $('flushBtn').addEventListener('click', async () => {
    if (!ensureReady()) return;
    sender.clearAuthFailure();
    setBanner('auth', 'bad', null);
    const r = await sender.flush();
    note('actionNote', r.remaining === 0 && r.sent === 0 && r.dropped === 0 ? 'Queue is empty.' : `Flushed: ${r.sent} sent, ${r.dropped} dropped, ${r.remaining} still queued.`);
    renderCounters();
  });
  $('saveBtn').addEventListener('click', saveSettings);
  $('resetBtn').addEventListener('click', resetSettings);
  $('copyOrigin').addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(location.origin);
      note('settingsNote', 'Origin copied.');
    } catch {
      note('settingsNote', 'Select and copy the origin manually.');
    }
  });

  window.addEventListener('online', () => {
    setBanner('offline', 'warn', null);
    checkServer();
  });
  window.addEventListener('offline', () => setBanner('offline', 'warn', { title: 'You are offline.', text: 'Bumps are kept in the queue and sent when the connection returns.' }));
  if (!navigator.onLine) window.dispatchEvent(new Event('offline'));

  setInterval(() => {
    if (sender.size > 0 && navigator.onLine) flushQueue();
  }, 10000);

  checkServer();
}
boot();
