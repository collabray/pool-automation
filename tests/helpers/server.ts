import { newCtx, type TestCtx } from './ctx.ts';
import { buildApp } from '../../src/server/app.ts';
import { DarajaClient } from '../../src/core/daraja.ts';
import type { FakeDaraja } from './fake-daraja.ts';
import { HttpApp } from '../../src/server/http.ts';
import { join } from 'node:path';

export interface TestServer { ctx: TestCtx; app: HttpApp; base: string; hub: ReturnType<typeof buildApp>['hub']; background: () => Promise<void>; close: () => Promise<void> }
export async function startServer(fake?: FakeDaraja, o: { webRoot?: string | null; corsOrigins?: string[] } = {}): Promise<TestServer> {
  const ctx = newCtx(); ctx.now = () => new Date(); // real time: HTTP-level tests
  const { app, hub, background } = buildApp({ ctx, pepper: 'pepper', http: { trustProxy: false, corsOrigins: o.corsOrigins ?? [], webRoot: o.webRoot === undefined ? join(import.meta.dirname, '..', '..', 'web') : o.webRoot, hsts: false },
    makeClient: (cfg, c) => new DarajaClient({ ...cfg, baseUrlOverride: fake?.url }, c.now) });
  const port = await app.listen(0, '127.0.0.1');
  return { ctx, app, base: `http://127.0.0.1:${port}`, hub, background, close: () => app.close() };
}

export interface Api { (method: string, path: string, body?: unknown, o?: { token?: string; idem?: string; headers?: Record<string, string> }): Promise<{ status: number; json: any; headers: Headers; text: string }> }
export const api = (base: string): Api => async (method, path, body, o = {}) => {
  const res = await fetch(base + path, { method, headers: { ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...(o.token ? { Authorization: `Bearer ${o.token}` } : {}), ...(o.idem ? { 'Idempotency-Key': o.idem } : {}), ...(o.headers ?? {}) }, body: body !== undefined ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(8000) });
  const text = await res.text(); let json: any = null; try { json = JSON.parse(text); } catch { /* not json */ }
  return { status: res.status, json, headers: res.headers, text };
};
