// localStorage wrapper. Constitution: every read/write inside try/catch, page must work without it.
const mem = new Map();

function backend() {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

export const store = {
  get(key, fallback = null) {
    try {
      const ls = backend();
      const raw = ls ? ls.getItem(key) : mem.get(key) ?? null;
      return raw === null || raw === undefined ? fallback : JSON.parse(raw);
    } catch {
      return mem.has(key) ? JSON.parse(mem.get(key)) : fallback;
    }
  },
  set(key, value) {
    const raw = JSON.stringify(value);
    mem.set(key, raw);
    try {
      const ls = backend();
      if (ls) ls.setItem(key, raw);
    } catch {
      /* in-memory copy already saved */
    }
  },
  remove(key) {
    mem.delete(key);
    try {
      backend()?.removeItem(key);
    } catch {
      /* ignore */
    }
  },
};
