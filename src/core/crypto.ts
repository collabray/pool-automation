import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

/** AES-256-GCM envelope: "v1:<iv>:<tag>:<ciphertext>" (base64 parts). */
export function loadMasterKey(b64: string | undefined): Buffer {
  if (!b64) throw new Error('APP_MASTER_KEY is not set');
  const key = Buffer.from(b64, 'base64');
  if (key.length !== 32) throw new Error('APP_MASTER_KEY must be 32 bytes, base64-encoded');
  return key;
}

export function encryptSecret(plain: string, key: Buffer): string {
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
  return ['v1', iv.toString('base64'), c.getAuthTag().toString('base64'), ct.toString('base64')].join(':');
}

export function decryptSecret(envelope: string, key: Buffer): string {
  const [v, iv, tag, ct] = envelope.split(':');
  if (v !== 'v1' || !iv || !tag || ct === undefined) throw new Error('Malformed secret envelope');
  const d = createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64'));
  d.setAuthTag(Buffer.from(tag, 'base64'));
  return Buffer.concat([d.update(Buffer.from(ct, 'base64')), d.final()]).toString('utf8');
}
