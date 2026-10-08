// Delivery with an offline queue (constitution 11): single POST first, queue on failure,
// flush through /v1/sensor-events/batch when the connection returns.
import { store as defaultStore } from './storage.js';

const QUEUE_KEY = 'sensor.outbox';
const QUEUE_CAP = 500;

/** What to do with an HTTP/network failure. */
export function classifyError(err) {
  if (err.kind === 'network' || err.kind === 'timeout') return 'retry';
  const s = err.status;
  if (s === 401 || s === 403) return 'auth';
  if (s === 429) return 'ratelimit';
  if (s >= 500) return 'retry';
  return 'drop'; // 400, 413, 415, 422 ...: retrying the same payload cannot succeed
}

export function classifyRejectCode(code) {
  if (code === 'RATE_LIMITED') return 'ratelimit';
  if (code === 'INTERNAL_ERROR' || code === 'DB_UNAVAILABLE') return 'retry';
  return 'drop';
}

export class Sender {
  constructor({ api, store = defaultStore, batchMax = 200, onStatus = () => {}, onReply = () => {}, now = () => Date.now() }) {
    this.api = api;
    this.store = store;
    this.batchMax = batchMax;
    this.onStatus = onStatus; // (clientEventId, status, detail)
    this.onReply = onReply; // (label, object)
    this.now = now;
    this.queue = store.get(QUEUE_KEY, []) || [];
    this.authFailed = false;
    this.pausedUntil = 0;
    this.flushing = false;
  }

  get size() {
    return this.queue.length;
  }

  clearAuthFailure() {
    this.authFailed = false;
  }

  _save() {
    this.store.set(QUEUE_KEY, this.queue);
  }

  _enqueue(payload, why) {
    if (this.queue.some((q) => q.client_event_id === payload.client_event_id)) return;
    this.queue.push(payload);
    if (this.queue.length > QUEUE_CAP) this.queue.splice(0, this.queue.length - QUEUE_CAP);
    this._save();
    this.onStatus(payload.client_event_id, 'queued', why);
  }

  _remember(err) {
    const kind = classifyError(err);
    if (kind === 'auth') this.authFailed = true;
    if (kind === 'ratelimit') this.pausedUntil = this.now() + (err.retryAfter ?? 30) * 1000;
    return kind;
  }

  /** Send one detected event. Never throws. */
  async submit(payload) {
    if (this.authFailed || this.queue.length > 0 || this.now() < this.pausedUntil) {
      this._enqueue(payload, this.authFailed ? 'sensor key rejected' : 'waiting for earlier events');
      return 'queued';
    }
    this.onStatus(payload.client_event_id, 'sending');
    try {
      const r = await this.api.postEvent(payload);
      this.onReply('POST /v1/sensor-events', { http: r.status, ...(r.data || {}) });
      const status = r.status === 200 ? 'duplicate' : 'sent';
      this.onStatus(payload.client_event_id, status, r.data);
      return status;
    } catch (err) {
      this.onReply('POST /v1/sensor-events', { error: err.message, code: err.code, http: err.status });
      const kind = this._remember(err);
      if (kind === 'drop') {
        this.onStatus(payload.client_event_id, 'rejected', err.code || err.message);
        return 'rejected';
      }
      this._enqueue(payload, kind === 'auth' ? 'sensor key rejected' : err.message);
      return 'queued';
    }
  }

  /** Flush the offline queue through the batch endpoint. Safe to call often. */
  async flush() {
    if (this.flushing || this.queue.length === 0) return { sent: 0, dropped: 0, remaining: this.queue.length };
    if (this.authFailed) return { sent: 0, dropped: 0, remaining: this.queue.length, blocked: 'auth' };
    if (this.now() < this.pausedUntil) return { sent: 0, dropped: 0, remaining: this.queue.length, blocked: 'ratelimit' };
    this.flushing = true;
    let sent = 0;
    let dropped = 0;
    try {
      while (this.queue.length > 0) {
        const chunk = this.queue.slice(0, this.batchMax);
        const outcome = await this._sendChunk(chunk);
        sent += outcome.sent;
        dropped += outcome.dropped;
        const done = new Set(outcome.finishedIds);
        this.queue = this.queue.filter((q) => !done.has(q.client_event_id));
        this._save();
        if (outcome.stop) break;
      }
    } finally {
      this.flushing = false;
    }
    return { sent, dropped, remaining: this.queue.length };
  }

  async _sendChunk(chunk) {
    const out = { sent: 0, dropped: 0, finishedIds: [], stop: false };
    try {
      const r = await this.api.postBatch(chunk);
      this.onReply('POST /v1/sensor-events/batch', { http: r.status, ...(r.data || {}) });
      const rejected = new Map((r.data?.rejected || []).map((x) => [x.client_event_id, x]));
      for (const p of chunk) {
        const rej = rejected.get(p.client_event_id);
        if (!rej) {
          out.sent++;
          out.finishedIds.push(p.client_event_id);
          this.onStatus(p.client_event_id, 'sent');
          continue;
        }
        const kind = classifyRejectCode(rej.code);
        if (kind === 'drop') {
          out.dropped++;
          out.finishedIds.push(p.client_event_id);
          this.onStatus(p.client_event_id, 'rejected', rej.code);
        } else {
          out.stop = true; // keep it queued and try again later
          if (kind === 'ratelimit') this.pausedUntil = this.now() + 30000;
        }
      }
      return out;
    } catch (err) {
      this.onReply('POST /v1/sensor-events/batch', { error: err.message, code: err.code, http: err.status });
      const kind = this._remember(err);
      if (kind !== 'drop') {
        out.stop = true;
        return out;
      }
      // The whole batch was refused (e.g. one bad event). Find the culprit by sending one by one.
      for (const p of chunk) {
        try {
          const r = await this.api.postEvent(p);
          out.sent++;
          out.finishedIds.push(p.client_event_id);
          this.onStatus(p.client_event_id, r.status === 200 ? 'duplicate' : 'sent');
        } catch (e2) {
          const k2 = this._remember(e2);
          if (k2 === 'drop') {
            out.dropped++;
            out.finishedIds.push(p.client_event_id);
            this.onStatus(p.client_event_id, 'rejected', e2.code || e2.message);
          } else {
            out.stop = true;
            break;
          }
        }
      }
      return out;
    }
  }

  /**
   * Replay path: post many payloads through the batch endpoint right away.
   * Network-type failures park the remainder in the offline queue instead of losing it.
   */
  async sendBatchDirect(payloads) {
    const total = { accepted: 0, duplicates: 0, rejected: [], queued: 0 };
    for (let i = 0; i < payloads.length; i += this.batchMax) {
      const chunk = payloads.slice(i, i + this.batchMax);
      try {
        const r = await this.api.postBatch(chunk);
        this.onReply('POST /v1/sensor-events/batch', { http: r.status, ...(r.data || {}) });
        total.accepted += r.data?.accepted ?? 0;
        total.duplicates += r.data?.duplicates ?? 0;
        total.rejected.push(...(r.data?.rejected || []));
      } catch (err) {
        this.onReply('POST /v1/sensor-events/batch', { error: err.message, code: err.code, http: err.status });
        const kind = this._remember(err);
        if (kind === 'drop') throw err;
        for (const p of payloads.slice(i)) this._enqueue(p, err.message);
        total.queued += payloads.length - i;
        if (kind === 'auth') throw err;
        break;
      }
    }
    return total;
  }
}
