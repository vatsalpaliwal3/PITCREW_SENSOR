// Replay CSV parser. Columns (constitution 11): recorded_at,lat,lng,x,y,z,speed_kmh
export const REPLAY_COLUMNS = ['recorded_at', 'lat', 'lng', 'x', 'y', 'z', 'speed_kmh'];

export function parseReplayCsv(text) {
  const clean = String(text ?? '').replace(/^﻿/, '');
  const lines = clean.split(/\r?\n/).filter((l) => l.trim() !== '');
  const errors = [];
  if (lines.length === 0) return { rows: [], errors: ['The file is empty.'] };

  const header = lines[0].split(',').map((c) => c.trim().toLowerCase());
  const idx = {};
  for (const col of REPLAY_COLUMNS) {
    idx[col] = header.indexOf(col);
    if (idx[col] === -1) errors.push(`Missing column "${col}". Expected: ${REPLAY_COLUMNS.join(',')}`);
  }
  if (errors.length) return { rows: [], errors };

  const rows = [];
  for (let i = 1; i < lines.length; i++) {
    const c = lines[i].split(',');
    const t = Date.parse(c[idx.recorded_at]?.trim());
    const nums = ['lat', 'lng', 'x', 'y', 'z', 'speed_kmh'].map((k) => Number(c[idx[k]]));
    if (!Number.isFinite(t) || nums.some((n) => !Number.isFinite(n)) || c[idx.lat]?.trim() === '') {
      if (errors.length < 5) errors.push(`Line ${i + 1} skipped (bad value).`);
      continue;
    }
    rows.push({ t, lat: nums[0], lng: nums[1], x: nums[2], y: nums[3], z: nums[4], speedKmh: Math.max(0, nums[5]) });
  }
  rows.sort((a, b) => a.t - b.t);
  return { rows, errors };
}
