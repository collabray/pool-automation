import { test } from 'node:test';
import assert from 'node:assert/strict';
import { kes, formatKes, toMpesaShillings, assertMinor } from '../src/core/money.ts';
import { normalizePhone, PhoneError, hashPhone, maskPhone } from '../src/core/phone.ts';
import { parsePricing, quote, gamesForAmount, unitPriceAt, PricingError, minGameValueMinor } from '../src/core/pricing.ts';
import { encryptSecret, decryptSecret } from '../src/core/crypto.ts';
import { TRANSITIONS, VEND_STATES, canTransition, assertTransition, IllegalTransitionError, isTerminal } from '../src/core/vend-state.ts';
import { signCommand, verifyCommand, MemoryReplayStore, signAck, verifyAck, parseVendParams, VendParamsError, type VendCommand } from '../src/core/command.ts';

const cfg = (o: Record<string, unknown> = {}) => parsePricing({ unitPriceMinor: kes(20), ...o });
const T = new Date('2026-10-20T09:00:00Z'); // Tuesday 12:00 Nairobi

test('money: integers only, formatting, mpesa conversion', () => {
  assert.equal(kes(20), 2000);
  assert.equal(formatKes(2000), 'KES 20');
  assert.equal(formatKes(2050), 'KES 20.50');
  assert.equal(toMpesaShillings(10000), 100);
  assert.throws(() => toMpesaShillings(2050));
  assert.throws(() => toMpesaShillings(0));
  assert.throws(() => assertMinor(20.5));
  assert.throws(() => assertMinor('20'));
});

test('phone: every accepted format normalises to 254XXXXXXXXX', () => {
  for (const [i, o] of [
    ['0712345678', '254712345678'], ['0112345678', '254112345678'], ['+254712345678', '254712345678'],
    ['254712345678', '254712345678'], ['254112345678', '254112345678'], [' 0712 345 678 ', '254712345678'],
    ['0712-345-678', '254712345678'],
  ]) assert.equal(normalizePhone(i), o);
});
test('phone: invalid inputs rejected', () => {
  for (const bad of ['', '071234567', '07123456789', '0212345678', '+255712345678', 'abcdefghij', '2547123456', '+2540712345678', null, undefined, 712345678]) {
    assert.throws(() => normalizePhone(bad), PhoneError, String(bad));
  }
});
test('phone: hash is keyed and stable; mask hides middle', () => {
  assert.equal(hashPhone('254712345678', 'a'), hashPhone('254712345678', 'a'));
  assert.notEqual(hashPhone('254712345678', 'a'), hashPhone('254712345678', 'b'));
  assert.throws(() => hashPhone('254712345678', ''));
  assert.equal(maskPhone('254712345678'), '25471****678');
});

test('pricing: KES 20 / 40 / 100 / custom without bundles', () => {
  const c = cfg();
  assert.equal(quote(c, 1, T).totalMinor, kes(20));
  assert.equal(quote(c, 2, T).totalMinor, kes(40));
  assert.equal(quote(c, 5, T).totalMinor, kes(100));
  assert.equal(quote(c, 7, T).totalMinor, kes(140));
  assert.deepEqual(gamesForAmount(c, kes(100), T), { games: 5, costMinor: kes(100), remainderMinor: 0 });
  assert.deepEqual(gamesForAmount(c, kes(20), T), { games: 1, costMinor: kes(20), remainderMinor: 0 });
  assert.deepEqual(gamesForAmount(c, kes(50), T), { games: 2, costMinor: kes(40), remainderMinor: kes(10) });
  assert.deepEqual(gamesForAmount(c, kes(19), T), { games: 0, costMinor: 0, remainderMinor: kes(19) });
});
test('pricing: bundle 6 games for KES 100', () => {
  const c = cfg({ bundles: [{ games: 6, priceMinor: kes(100) }], maxGames: 30 });
  assert.equal(quote(c, 6, T).totalMinor, kes(100));
  assert.equal(quote(c, 5, T).totalMinor, kes(100));
  assert.equal(quote(c, 7, T).totalMinor, kes(120));
  assert.equal(quote(c, 12, T).totalMinor, kes(200));
  assert.deepEqual(gamesForAmount(c, kes(100), T), { games: 6, costMinor: kes(100), remainderMinor: 0 });
  assert.equal(gamesForAmount(c, kes(200), T).games, 12);
  assert.equal(minGameValueMinor(c, T), Math.floor(kes(100) / 6));
  const lines = quote(c, 7, T).lines;
  assert.deepEqual(lines.map((l) => [l.kind, l.count]).sort(), [['bundle', 1], ['single', 1]]);
});
test('pricing: bounds and config validation', () => {
  const c = cfg({ minGames: 2, maxGames: 10 });
  assert.throws(() => quote(c, 1, T), PricingError);
  assert.throws(() => quote(c, 11, T), PricingError);
  assert.throws(() => quote(c, 2.5, T), PricingError);
  assert.throws(() => parsePricing({ unitPriceMinor: 20.5 }), PricingError);
  assert.throws(() => parsePricing({ unitPriceMinor: 0 }), PricingError);
  assert.throws(() => parsePricing({ unitPriceMinor: 100, remainderPolicy: 'KEEP' }), PricingError);
  assert.throws(() => parsePricing({ unitPriceMinor: 100, bundles: [{ games: 1, priceMinor: 5 }] }), PricingError);
});
test('pricing: peak/off-peak windows incl. midnight wrap (Nairobi UTC+3)', () => {
  const c = cfg({ peakWindows: [{ days: [5, 6], startMin: 18 * 60, endMin: 2 * 60, priceMinor: kes(30) }, { days: [1, 2, 3, 4], startMin: 17 * 60, endMin: 20 * 60, priceMinor: kes(25) }] });
  assert.equal(unitPriceAt(c, new Date('2026-10-20T09:00:00Z')), kes(20)); // Tue 12:00
  assert.equal(unitPriceAt(c, new Date('2026-10-20T15:00:00Z')), kes(25)); // Tue 18:00
  assert.equal(unitPriceAt(c, new Date('2026-10-23T16:00:00Z')), kes(30)); // Fri 19:00
  assert.equal(unitPriceAt(c, new Date('2026-10-23T22:00:00Z')), kes(30)); // Sat 01:00 (Fri window wraps)
  assert.equal(unitPriceAt(c, new Date('2026-10-23T23:30:00Z')), kes(20)); // Sat 02:30 after window
  assert.equal(unitPriceAt(c, new Date('2026-10-21T22:00:00Z')), kes(20)); // Thu 01:00: Wed has no wrap window
  assert.equal(quote(c, 2, new Date('2026-10-23T16:00:00Z')).totalMinor, kes(60));
});

test('crypto: round trip, tamper and wrong key fail', () => {
  const key = Buffer.alloc(32, 1);
  const enc = encryptSecret('s3cret', key);
  assert.equal(decryptSecret(enc, key), 's3cret');
  assert.notEqual(encryptSecret('s3cret', key), enc); // random IV
  assert.throws(() => decryptSecret(enc, Buffer.alloc(32, 2)));
  const parts = enc.split(':'); parts[3] = Buffer.from('x').toString('base64');
  assert.throws(() => decryptSecret(parts.join(':'), key));
  assert.throws(() => decryptSecret('junk', key));
});

test('vend state machine: every pair checked against the table; terminals have no exits', () => {
  const legal = new Set(['QUEUED>SENT', 'QUEUED>CANCELLED', 'SENT>ACKED', 'SENT>FAILED', 'SENT>CANCELLED', 'ACKED>CONFIRMED', 'ACKED>FAILED',
    'FAILED>QUEUED', 'FAILED>ACKED', 'FAILED>REFUNDED', 'FAILED>CANCELLED']);
  let checked = 0;
  for (const a of VEND_STATES) for (const b of VEND_STATES) {
    checked++;
    assert.equal(canTransition(a, b), legal.has(`${a}>${b}`), `${a}>${b}`);
    if (legal.has(`${a}>${b}`)) assertTransition(a, b); else assert.throws(() => assertTransition(a, b), IllegalTransitionError);
  }
  assert.equal(checked, 49);
  for (const s of ['CONFIRMED', 'CANCELLED', 'REFUNDED'] as const) { assert.ok(isTerminal(s)); assert.equal(TRANSITIONS[s].length, 0); }
});

const cmd = (o: Partial<VendCommand> = {}): VendCommand => ({ v: 1, vendId: 'v1', tableId: 't1', deviceId: 'd1', mode: 'COIN_PULSE', pulses: 2, pulseMs: 50, gapMs: 60, holdMs: 0,
  nonce: 'a'.repeat(32), issuedAt: 1_000_000, expiresAt: 1_030_000, ...o });
const SEC = 'device-secret';

test('command: valid signature accepted once, replay rejected', () => {
  const c = cmd(); const sig = signCommand(c, SEC); const r = new MemoryReplayStore();
  assert.deepEqual(verifyCommand(c, sig, SEC, 1_010_000, r), { ok: true });
  assert.deepEqual(verifyCommand(c, sig, SEC, 1_010_000, r), { ok: false, reason: 'REPLAY' });
});
test('command: any tampered field or wrong key fails signature', () => {
  const c = cmd(); const sig = signCommand(c, SEC);
  const variants: Partial<VendCommand>[] = [{ vendId: 'v2' }, { tableId: 't2' }, { deviceId: 'd2' }, { mode: 'GATE_SOLENOID' }, { pulses: 3 }, { pulseMs: 51 }, { gapMs: 61 }, { holdMs: 1 }, { nonce: 'b'.repeat(32) }, { issuedAt: 1_000_001 }, { expiresAt: 9_999_999 }];
  for (const v of variants) assert.deepEqual(verifyCommand(cmd(v), sig, SEC, 1_010_000, new MemoryReplayStore()), { ok: false, reason: 'BAD_SIGNATURE' }, JSON.stringify(v));
  assert.deepEqual(verifyCommand(c, sig, 'other', 1_010_000, new MemoryReplayStore()), { ok: false, reason: 'BAD_SIGNATURE' });
  assert.deepEqual(verifyCommand(c, 'zz', SEC, 1_010_000, new MemoryReplayStore()), { ok: false, reason: 'BAD_FORMAT' });
});
test('command: expiry and drift window; failed checks do not burn the nonce', () => {
  const c = cmd(); const sig = signCommand(c, SEC); const r = new MemoryReplayStore();
  assert.deepEqual(verifyCommand(c, sig, SEC, 1_030_000 + 5_001, r), { ok: false, reason: 'EXPIRED' });
  assert.deepEqual(verifyCommand(c, sig, SEC, 1_000_000 - 5_001, r), { ok: false, reason: 'NOT_YET_VALID' });
  assert.deepEqual(verifyCommand(c, sig, SEC, 1_030_000 + 4_999, r), { ok: true }); // inside drift tolerance
});
test('ack: sign/verify, tamper detected', () => {
  const a = { vendId: 'v1', nonce: 'n', status: 'ACK' as const, ts: 5 };
  const s = signAck(a, SEC);
  assert.ok(verifyAck(a, s, SEC));
  assert.ok(!verifyAck({ ...a, status: 'CONFIRMED' }, s, SEC));
  assert.ok(!verifyAck(a, s, 'x'));
});
test('vend params: per-mode defaults and max-pulse guard', () => {
  assert.deepEqual(parseVendParams('COIN_PULSE', {}), { pulses: 1, pulseMs: 50, gapMs: 50, holdMs: 0 });
  assert.equal(parseVendParams('GATE_SOLENOID', {}).holdMs, 1500);
  assert.throws(() => parseVendParams('GATE_SOLENOID', { holdMs: 5001 }), VendParamsError);
  assert.throws(() => parseVendParams('SOLENOID_SLIDE', { holdMs: 10 }), VendParamsError);
  assert.throws(() => parseVendParams('COIN_PULSE', { pulses: 21 }), VendParamsError);
});
