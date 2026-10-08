// UUID helpers. Constitution 4.1: IDs are UUID v4, lowercase.
export const UUID_V4_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function format(bytes) {
  const b = Uint8Array.from(bytes);
  b[6] = (b[6] & 0x0f) | 0x40; // version 4
  b[8] = (b[8] & 0x3f) | 0x80; // variant 10xx
  const hex = Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function uuidv4() {
  const c = globalThis.crypto;
  if (c && typeof c.randomUUID === 'function') return c.randomUUID().toLowerCase();
  const bytes = new Uint8Array(16);
  c.getRandomValues(bytes);
  return format(bytes);
}

// Stable v4-shaped id derived from a seed. Used for replay so that running the
// same replay twice is idempotent on the server (same client_event_id).
export async function deterministicUuid(seed) {
  const digest = await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(seed));
  return format(new Uint8Array(digest).slice(0, 16));
}
