// Pure helper shared by the browser app and the build script.
// Returns { ok, value, error }. Empty input is valid (means "not set").
export function normalizeBaseUrl(input) {
  const raw = String(input ?? '').trim();
  if (!raw) return { ok: true, value: '' };
  if (!/^https:\/\//i.test(raw)) {
    return { ok: false, value: '', error: 'Must start with https:// (browsers block plain http calls from an https page).' };
  }
  let u;
  try {
    u = new URL(raw);
  } catch {
    return { ok: false, value: '', error: 'This is not a valid URL.' };
  }
  const path = u.pathname.replace(/\/+$/, '').replace(/\/v1$/, '');
  return { ok: true, value: u.origin + path };
}
