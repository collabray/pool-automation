// Converts between the human-friendly pricing form (shillings, one rule per line) and the server's integer-minor-unit JSON.
import { toMinor } from './format.js';

export class FormError extends Error {}
/** "6=100" per line => [{games:6, priceMinor:10000}] */
export function parseBundles(text) {
  const out = [];
  for (const line of String(text || '').split('\n').map((l) => l.trim()).filter(Boolean)) {
    const m = /^(\d+)\s*[=:]\s*(\d+(?:\.\d{1,2})?)$/.exec(line); if (!m) throw new FormError(`Bundle "${line}" must look like 6=100 (6 games for KES 100)`);
    out.push({ games: Number(m[1]), priceMinor: toMinor(m[2]) });
  }
  return out;
}
export const formatBundles = (bundles) => (bundles || []).map((b) => `${b.games}=${b.priceMinor / 100}`).join('\n');
const DAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
const hm = (s) => { const m = /^(\d{1,2}):(\d{2})$/.exec(s); if (!m || +m[1] > 24 || +m[2] > 59) throw new FormError(`Time "${s}" must look like 18:30`); return +m[1] * 60 + +m[2]; };
/** "fri,sat; 18:00-02:00; 30" per line => peak window (days are 0=Sun..6=Sat) */
export function parsePeak(text) {
  const out = [];
  for (const line of String(text || '').split('\n').map((l) => l.trim()).filter(Boolean)) {
    const parts = line.split(';').map((p) => p.trim()); if (parts.length !== 3) throw new FormError(`Peak rule "${line}" must look like: fri,sat; 18:00-02:00; 30`);
    const days = parts[0].split(',').map((d) => DAYS.indexOf(d.trim().toLowerCase().slice(0, 3))); if (!days.length || days.includes(-1)) throw new FormError(`Unknown day in "${line}" (use mon,tue,...)`);
    const [a, b] = parts[1].split('-'); if (!b) throw new FormError(`Time range in "${line}" must look like 18:00-02:00`);
    if (!/^\d+(?:\.\d{1,2})?$/.test(parts[2])) throw new FormError(`Price in "${line}" must be a number of shillings`);
    out.push({ days, startMin: hm(a.trim()), endMin: Math.min(1440, hm(b.trim())), priceMinor: toMinor(parts[2]) });
  }
  return out;
}
const t2 = (m) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
export const formatPeak = (w) => (w || []).map((x) => `${x.days.map((d) => DAYS[d]).join(',')}; ${t2(x.startMin)}-${t2(x.endMin)}; ${x.priceMinor / 100}`).join('\n');
export function buildPricing(f) {
  const unit = Number(f.unit); if (!(unit > 0)) throw new FormError('Price per game must be more than 0');
  return { unitPriceMinor: toMinor(unit), bundles: parseBundles(f.bundles), peakWindows: parsePeak(f.peak), utcOffsetMinutes: 180, minGames: Number(f.min) || 1, maxGames: Number(f.max) || 20, remainderPolicy: f.remainder || 'HOLD_CREDIT' };
}
