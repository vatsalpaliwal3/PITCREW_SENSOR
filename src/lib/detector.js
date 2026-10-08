// Bump detector
//
// Detects strong vertical acceleration events while rejecting
// short, isolated jerks/noise.

export const DEFAULTS = Object.freeze({
  gravity: 9.81,

  // Minimum deviation needed to start considering an event.
  threshold: 4.5,

  // Stronger threshold used to confirm that this is a real bump.
  confirmThreshold: 5.0,

  // Require at least this many strong samples.
  minStrongSamples: 2,

  // Require the event to last at least this long.
  minDurationMs: 30,

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
    this.g = null;
    this.lastT = null;
    this.dtEma = 16;

    this.win = null;
    this.cooldownUntil = -Infinity;
  }

  push({ t, x, y, z, ctx = null }) {
    if (![t, x, y, z].every(Number.isFinite)) {
      return {
        deviation: null,
        event: null
      };
    }

    const dt =
      this.lastT === null
        ? 0
        : Math.max(0, Math.min(1000, t - this.lastT));

    if (dt > 0) {
      this.dtEma = this.dtEma * 0.9 + dt * 0.1;
    }

    this.lastT = t;

    let zv;

    // -----------------------------
    // Vertical acceleration
    // -----------------------------

    if (this.o.mode === 'flat') {
      zv = z;
    } else {
      const mag = Math.hypot(x, y, z);

      if (mag < 1) {
        return {
          deviation: null,
          event: null
        };
      }

      if (!this.g) {
        this.g = [x, y, z];
      }

      const gm =
        Math.hypot(
          this.g[0],
          this.g[1],
          this.g[2]
        ) || 1;

      zv =
        (x * this.g[0] +
          y * this.g[1] +
          z * this.g[2]) /
        gm;

      // Slowly update gravity direction.
      const a =
        dt / (this.o.tauMs + dt);

      this.g = [
        this.g[0] + a * (x - this.g[0]),
        this.g[1] + a * (y - this.g[1]),
        this.g[2] + a * (z - this.g[2])
      ];
    }

    const deviation = Math.abs(
      zv - this.o.gravity
    );

    const thr = this.o.threshold;

    // -----------------------------
    // Cooldown
    // -----------------------------

    if (t < this.cooldownUntil) {
      this.win = null;

      return {
        deviation,
        zVertical: zv,
        event: null
      };
    }

    // -----------------------------
    // Start / update event
    // -----------------------------

    if (deviation >= thr) {

      if (!this.win) {

        this.win = {
          start: t,
          last: t,
          peak: deviation,
          ctx,

          // NEW:
          strongSamples:
            deviation >= this.o.confirmThreshold
              ? 1
              : 0
        };

      } else {

        this.win.last = t;

        if (deviation > this.win.peak) {
          this.win.peak = deviation;
          this.win.ctx = ctx;
        }

        if (
          deviation >=
          this.o.confirmThreshold
        ) {
          this.win.strongSamples++;
        }
      }
    }

    // -----------------------------
    // Finish event
    // -----------------------------

    if (this.win) {

      const duration =
        this.win.last -
        this.win.start +
        this.dtEma;

      const released =
        deviation < thr &&
        t - this.win.last >=
          this.o.releaseMs;

      const timedOut =
        t - this.win.start >=
        this.o.maxWindowMs;

      if (released || timedOut) {

        // NEW:
        // Reject isolated small jerks.
        const confirmed =
          this.win.strongSamples >=
            this.o.minStrongSamples &&
          duration >=
            this.o.minDurationMs;

        if (confirmed) {
          const event = this._finish();

          return {
            deviation,
            zVertical: zv,
            event
          };
        }

        // Not enough evidence → discard it.
        this.win = null;

        return {
          deviation,
          zVertical: zv,
          event: null
        };
      }
    }

    return {
      deviation,
      zVertical: zv,
      event: null
    };
  }

  flush() {
    if (!this.win) return null;

    const duration =
      this.win.last -
      this.win.start +
      this.dtEma;

    const confirmed =
      this.win.strongSamples >=
        this.o.minStrongSamples &&
      duration >=
        this.o.minDurationMs;

    if (!confirmed) {
      this.win = null;
      return null;
    }

    return this._finish();
  }

  _finish() {
    const w = this.win;

    this.win = null;

    this.cooldownUntil =
      w.last + this.o.cooldownMs;

    return {
      peak: round3(w.peak),

      durationMs: Math.max(
        1,
        Math.round(
          w.last -
            w.start +
            this.dtEma
        )
      ),

      tStart: w.start,
      tEnd: w.last,
      ctx: w.ctx
    };
  }
}