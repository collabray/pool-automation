/** Money is integer minor units (1 KES = 100). Never floats. */
export function kes(minor) {
  if (minor === null || minor === undefined) return '\u2014';
  const sign = minor < 0 ? '-' : '';
  const abs = Math.abs(minor), whole = Math.floor(abs / 100), cents = abs % 100;
  return `KES ${sign}${String(whole).replace(/\B(?=(\d{3})+(?!\d))/g, ',')}${cents ? '.' + String(cents).padStart(2, '0') : ''}`;
}
export const toMinor = (shillings) => Math.round(Number(shillings) * 100);
const EAT = 3 * 3600_000;
export function fmtDateTime(iso) { if (!iso) return '\u2014'; const d = new Date(Date.parse(iso) + EAT); return d.toISOString().slice(0, 16).replace('T', ' '); }
export function fmtTime(iso) { return iso ? fmtDateTime(iso).slice(11) : '\u2014'; }
export function ago(iso, now = Date.now()) {
  if (!iso) return 'never'; const s = Math.max(0, Math.round((now - Date.parse(iso)) / 1000));
  return s < 60 ? `${s}s ago` : s < 3600 ? `${Math.floor(s / 60)}m ago` : s < 86400 ? `${Math.floor(s / 3600)}h ago` : `${Math.floor(s / 86400)}d ago`;
}
export const pct = (a, b) => (b ? Math.round((a / b) * 100) : 0);
