// Generates docs/openapi.json from the live route table + request schemas.   Usage: node scripts/gen-openapi.ts > docs/openapi.json
import { newCtx } from '../tests/helpers/ctx.ts';
import { buildApp } from '../src/server/app.ts';
import type { Field } from '../src/server/schema.ts';

const js = (f: Field): any => {
  switch (f.t) {
    case 'str': return { type: 'string', ...(f.min ? { minLength: f.min } : {}), ...(f.max ? { maxLength: f.max } : {}), ...(f.re ? { pattern: f.re.source } : {}) };
    case 'int': return { type: 'integer', ...(f.min !== undefined ? { minimum: f.min } : {}), ...(f.max !== undefined ? { maximum: f.max } : {}) };
    case 'bool': return { type: 'boolean' }; case 'enum': return { type: 'string', enum: f.values }; case 'free': return { type: 'object', additionalProperties: true };
    case 'arr': return { type: 'array', maxItems: f.max, items: js(f.item) };
    case 'obj': return objSchema(f.shape);
  }
};
const objSchema = (shape: Record<string, Field>) => ({ type: 'object', additionalProperties: false, required: Object.entries(shape).filter(([, v]) => !v.opt).map(([k]) => k), properties: Object.fromEntries(Object.entries(shape).map(([k, v]) => [k, js(v)])) });
const ctx = newCtx(); const { app } = buildApp({ ctx, pepper: 'x', http: { trustProxy: false, corsOrigins: [], webRoot: null, hsts: false } });
const paths: Record<string, any> = {};
for (const r of app.listRoutes()) {
  const p = r.path.replace(/:([A-Za-z]+)/g, '{$1}'); const params = [...r.path.matchAll(/:([A-Za-z]+)/g)].map((m) => ({ name: m[1], in: 'path', required: true, schema: { type: 'string' } }));
  const hdr = r.idem ? [{ name: 'Idempotency-Key', in: 'header', required: r.idem === 'required', schema: { type: 'string', maxLength: 200 }, description: 'Repeating a request with the same key returns the original response instead of acting twice.' }] : [];
  (paths[p] ??= {})[r.method.toLowerCase()] = {
    summary: `${r.method} ${r.path}`, tags: [r.path.split('/')[2] ?? 'api'],
    security: r.auth === 'user' ? [{ bearer: [] }] : r.auth === 'device' ? [{ deviceSignature: [] }] : [],
    ...(r.roles ? { 'x-roles': r.roles } : {}), parameters: [...params, ...hdr],
    ...(r.body ? { requestBody: { required: true, content: { 'application/json': { schema: objSchema(r.body) } } } } : {}),
    responses: { '200': { description: 'OK' }, '400': { description: 'Validation error' }, ...(r.auth !== 'public' ? { '401': { description: 'Not authenticated' } } : {}), ...(r.roles ? { '403': { description: 'Role not allowed' } } : {}), '429': { description: 'Rate limited' } },
  };
}
console.log(JSON.stringify({ openapi: '3.0.3', info: { title: 'Pool Table Payment Automation API', version: '1.0.0', description: 'Generated from the route table. Money is always integer minor units (1 KES = 100). Errors: { "error": { "code", "message", "details?" } }.' },
  components: { securitySchemes: { bearer: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' }, deviceSignature: { type: 'apiKey', in: 'header', name: 'X-Sig', description: 'HMAC-SHA256 over METHOD\\nPATH\\nTS\\nNONCE\\nSHA256(body) with the per-device secret; also send X-Device-Id, X-Ts, X-Nonce.' } } }, paths }, null, 2));
