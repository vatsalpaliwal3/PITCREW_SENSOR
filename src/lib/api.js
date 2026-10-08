// Thin fetch client for the backend (constitution 8). Base URL and key are injected, never literals.
import { uuidv4 } from './uuid.js';

export class ApiError extends Error {
  constructor(kind, message, extra = {}) {
    super(message);
    this.kind = kind; // 'config' | 'network' | 'timeout' | 'http'
    this.status = extra.status ?? null;
    this.code = extra.code ?? null;
    this.details = extra.details ?? null;
    this.requestId = extra.requestId ?? null;
    this.retryAfter = extra.retryAfter ?? null; // seconds
  }
}

export function createApi({ getBaseUrl, getKey, fetchImpl = (...a) => globalThis.fetch(...a), firstTimeoutMs = 60000, nextTimeoutMs = 20000 }) {
  let warm = false; // first request may hit a Render cold start (constitution 10.3)

  async function request(method, path, { body, auth = false } = {}) {
    const base = getBaseUrl();
    if (!base) throw new ApiError('config', 'API base URL is not set. Open Settings and enter it.');
    const headers = { Accept: 'application/json' };
    if (body !== undefined) {
      headers['Content-Type'] = 'application/json';
      headers['X-Request-ID'] = uuidv4();
    }
    if (auth) {
      const key = getKey();
      if (!key) throw new ApiError('config', 'Sensor key is not set. Open Settings and enter it.');
      headers['X-Sensor-Key'] = key;
    }
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), warm ? nextTimeoutMs : firstTimeoutMs);
    let res;
    try {
      res = await fetchImpl(base + path, {
        method,
        headers,
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal: ctrl.signal,
        cache: 'no-store',
        credentials: 'omit',
        mode: 'cors',
      });
    } catch (e) {
      if (ctrl.signal.aborted) throw new ApiError('timeout', 'The server did not answer in time.');
      throw new ApiError('network', 'Could not reach the server (offline, wrong URL, or CORS not allowing this origin).');
    } finally {
      clearTimeout(timer);
    }

    let data = null;
    try {
      const text = await res.text();
      data = text ? JSON.parse(text) : null;
    } catch {
      data = null;
    }
    const meta = { requestId: res.headers.get('X-Request-ID'), apiVersion: res.headers.get('X-API-Version') };
    if (res.ok) {
      warm = true;
      return { status: res.status, data, ...meta };
    }
    const retryAfterRaw = Number(res.headers.get('Retry-After'));
    throw new ApiError('http', data?.error?.message || `HTTP ${res.status}`, {
      status: res.status,
      code: data?.error?.code ?? null,
      details: data?.error?.details ?? null,
      requestId: data?.error?.request_id ?? meta.requestId,
      retryAfter: Number.isFinite(retryAfterRaw) && retryAfterRaw > 0 ? retryAfterRaw : null,
    });
  }

  return {
    isWarm: () => warm,
    health: (deep = false) => request('GET', `/health${deep ? '?deep=true' : ''}`),
    config: () => request('GET', '/v1/config'),
    postEvent: (payload) => request('POST', '/v1/sensor-events', { body: payload, auth: true }),
    postBatch: (events) => request('POST', '/v1/sensor-events/batch', { body: { events }, auth: true }),
  };
}
