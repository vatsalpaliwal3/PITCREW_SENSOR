// Bump detector (constitution 4.2, 5.4, 11).
//
// Contract: peak_z_deviation = abs(z - 9.81), sent only when >= MIN_PEAK_Z_DEVIATION.
// "z" is the acceleration along the vertical axis, gravity included.
//   mode 'flat'  : z is the raw Z axis of the phone (phone lying flat).
//   mode 'auto'  : z is the acceleration projected on the gravity direction, estimated
//                  with a slow low-pass filter. Identical to 'flat' when the phone lies flat,
//                  and still correct when the phone sits upright in a dashboard holder.
// The detector is pure and clock-free: callers pass the timestamp `t` (ms) with every sample,
// so live sensing and CSV replay use exactly the same code path.

export const DEFAULTS = Object.freeze({
  gravity: 9.81,
  threshold: 3.0,
  cooldownMs: 1500,
  releaseMs: 120,
  maxWindowMs: 800,
  tauMs: 800,
  mode: 'auto',
});

const round3 = (v) => Math.round(v * 1000) / 1000;

export class BumpDetector {
  constructor(opts = {}) {
    this.o = { ...DEFAULTS, ...opts };
    this.reset();
  }

  configure(opts) {
    Object.assign(this.o, opts);
  }

  reset() {
    this.g = null; // low-pass gravity vector
    this.lastT = null;
    this.dtEma = 16;
    this.win = null;
    this.cooldownUntil = -Infinity;
  }

  /** Feed one sample. Returns { deviation, event }. event is null or a finished spike. */
  push({ t, x, y, z, ctx = null }) {
    if (![t, x, y, z].every(Number.isFinite)) return { deviation: null, event: null };

    const dt = this.lastT === null ? 0 : Math.max(0, Math.min(1000, t - this.lastT));
    if (dt > 0) this.dtEma = this.dtEma * 0.9 + dt * 0.1;
    this.lastT = t;

    let zv;
    if (this.o.mode === 'flat') {
      zv = z;
    } else {
      const mag = Math.hypot(x, y, z);
      if (mag < 1) return { deviation: null, event: null }; // free fall, no usable direction
      if (!this.g) this.g = [x, y, z];
      const gm = Math.hypot(this.g[0], this.g[1], this.g[2]) || 1;
      zv = (x * this.g[0] + y * this.g[1] + z * this.g[2]) / gm;
      // Update the gravity estimate AFTER using it. Normalised, so a spike along the vertical
      // axis does not move the direction; a real re-orientation is absorbed in about 3 x tau.
      const a = dt / (this.o.tauMs + dt);
      this.g = [this.g[0] + a * (x - this.g[0]), this.g[1] + a * (y - this.g[1]), this.g[2] + a * (z - this.g[2])];
    }

    const deviation = Math.abs(zv - this.o.gravity);
    const thr = this.o.threshold;

    if (t < this.cooldownUntil) {
      this.win = null;
      return { deviation, zVertical: zv, event: null };
    }

    let event = null;
    if (deviation >= thr) {
      if (!this.win) this.win = { start: t, last: t, peak: deviation, ctx };
      else {
        this.win.last = t;
        if (deviation > this.win.peak) {
          this.win.peak = deviation;
          this.win.ctx = ctx;
        }
      }
    }
    if (this.win && ((deviation < thr && t - this.win.last >= this.o.releaseMs) || t - this.win.start >= this.o.maxWindowMs)) {
      event = this._finish();
    }
    return { deviation, zVertical: zv, event };
  }

  /** Call when the sample stream ends so a pending spike is not lost. */
  flush() {
    return this.win ? this._finish() : null;
  }

  _finish() {
    const w = this.win;
    this.win = null;
    this.cooldownUntil = w.last + this.o.cooldownMs;
    return {
      peak: round3(w.peak),
      durationMs: Math.max(1, Math.round(w.last - w.start + this.dtEma)),
      tStart: w.start,
      tEnd: w.last,
      ctx: w.ctx,
    };
  }
}
