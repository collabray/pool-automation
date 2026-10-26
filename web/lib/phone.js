/** Same rules as the server: 07XXXXXXXX, 01XXXXXXXX, +2547XXXXXXXX, 2547XXXXXXXX, 2541XXXXXXXX -> 254XXXXXXXXX. Returns null when invalid. */
export function normalizePhone(input) {
  if (typeof input !== 'string') return null;
  const m = /^(?:\+?254|0)([71]\d{8})$/.exec(input.trim().replace(/[\s\-().]/g, ''));
  return m ? '254' + m[1] : null;
}
