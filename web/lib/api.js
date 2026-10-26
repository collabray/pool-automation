/**
 * API client. Access token lives in memory (+ storage for page reloads), refresh tokens rotate on every use,
 * and a 401 triggers exactly one silent refresh + retry. Every mutating call can carry an Idempotency-Key.
 */
export const newKey = () => (globalThis.crypto && crypto.randomUUID ? crypto.randomUUID() : 'k' + Math.random().toString(36).slice(2) + Date.now().toString(36));

export class ApiError extends Error {
  constructor(status, code, message, details) { super(message); this.status = status; this.code = code; this.details = details; }
}

export function createApi({ base = '', storage = globalThis.sessionStorage, fetchImpl = (...a) => globalThis.fetch(...a), prefix = 'pt.' } = {}) {
  let session = null;
  try { session = JSON.parse(storage?.getItem(prefix + 'session') || 'null'); } catch { session = null; }
  let refreshing = null;
  const save = () => { if (!storage) return; if (session) storage.setItem(prefix + 'session', JSON.stringify(session)); else storage.removeItem(prefix + 'session'); };

  async function raw(method, path, body, { idem, token = session?.accessToken, signal } = {}) {
    const headers = {};
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    if (token) headers.Authorization = `Bearer ${token}`;
    if (idem) headers['Idempotency-Key'] = idem;
    return fetchImpl(base + path, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined, signal });
  }
  async function refresh() {
    if (!session?.refreshToken) return false;
    refreshing ??= (async () => {
      try {
        const res = await raw('POST', '/api/auth/refresh', { refreshToken: session.refreshToken }, { token: null });
        if (!res.ok) { session = null; save(); return false; }
        const j = await res.json(); session = { accessToken: j.accessToken, refreshToken: j.refreshToken, user: j.user }; save(); return true;
      } finally { refreshing = null; }
    })();
    return refreshing;
  }
  async function request(method, path, body, opts = {}) {
    let res = await raw(method, path, body, opts);
    if (res.status === 401 && session && !opts.noRefresh && await refresh()) res = await raw(method, path, body, opts);
    const text = await res.text(); let json = null; try { json = text ? JSON.parse(text) : null; } catch { /* binary or text body */ }
    if (!res.ok) {
      const d = json?.error?.details; const detail = json?.error?.code === 'VALIDATION' && Array.isArray(d) ? d.map((x) => String(x).replace(/^body\./, '')).join('; ') : '';
      throw new ApiError(res.status, json?.error?.code || 'ERROR', detail ? `Check the form: ${detail}` : json?.error?.message || `HTTP ${res.status}`, d);
    }
    return opts.text ? text : json;
  }
  return {
    get user() { return session?.user ?? null; }, get loggedIn() { return !!session?.accessToken; },
    get: (p, o) => request('GET', p, undefined, o), post: (p, b, o) => request('POST', p, b ?? {}, o), patch: (p, b, o) => request('PATCH', p, b ?? {}, o), put: (p, b, o) => request('PUT', p, b ?? {}, o),
    async login(username, secret, kind = 'password', totp) {
      const j = await request('POST', kind === 'pin' ? '/api/auth/pin-login' : '/api/auth/login', kind === 'pin' ? { username, pin: secret } : { username, password: secret, ...(totp ? { totp } : {}) }, { noRefresh: true, token: null });
      session = { accessToken: j.accessToken, refreshToken: j.refreshToken, user: j.user }; save(); return j.user;
    },
    async logout() { const rt = session?.refreshToken; session = null; save(); if (rt) { try { await raw('POST', '/api/auth/logout', { refreshToken: rt }, { token: null }); } catch { /* offline logout is fine */ } } },
    /** Authenticated download (CSV/PDF/SVG): returns a Blob. */
    async blob(path) { let res = await raw('GET', path); if (res.status === 401 && await refresh()) res = await raw('GET', path); if (!res.ok) throw new ApiError(res.status, 'ERROR', `HTTP ${res.status}`); return res.blob(); },
  };
}
