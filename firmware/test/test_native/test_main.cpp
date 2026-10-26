// Native (PC) tests for the portable firmware core. Run with `pio test -e native` or `tools/run-native-tests.sh`.
#include <unity.h>
#include <string>
#include <vector>
#include "coin_counter.h"
#include "device_core.h"
#include "mini_json.h"
#include "protocol.h"
#include "sha256.h"
#include "vend_sequencer.h"
#include "vectors.h"

using namespace pt;
void setUp() {} void tearDown() {}

// ---------- hashing (vectors from NIST / RFC 4231; long-input vectors computed with Node's crypto) ----------
void test_sha256_known() {
  TEST_ASSERT_EQUAL_STRING("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad", sha256Hex("abc"));
  TEST_ASSERT_EQUAL_STRING("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855", sha256Hex(""));
  TEST_ASSERT_EQUAL_STRING("248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1", sha256Hex("abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq"));
  TEST_ASSERT_EQUAL_STRING("cdc76e5c9914fb9281a1c7e284d73e67f1809a48a497200e046d39ccc7112cd0", sha256Hex(std::string(1000000, 'a')));
}
void test_sha256_block_boundaries_and_streaming() {
  for (size_t n : {55u, 56u, 57u, 63u, 64u, 65u, 119u, 120u, 128u}) {
    std::string s(n, 'x'); Sha256 a; a.update((const uint8_t*)s.data(), n); uint8_t o1[32]; a.final(o1);
    Sha256 b; for (size_t i = 0; i < n; i++) b.update((const uint8_t*)&s[i], 1); uint8_t o2[32]; b.final(o2);  // byte-by-byte must equal one-shot
    TEST_ASSERT_EQUAL_MEMORY(o1, o2, 32);
  }
  TEST_ASSERT_EQUAL_STRING("9f4390f8d30c2dd92ec9f095b65e2b9ae9b0a925a5258e241c9f1e910f734318", sha256Hex(std::string(55, 'a')));
  TEST_ASSERT_EQUAL_STRING("b35439a4ac6f0948b6d6f9e3c6af0f5f590ce20f1bde7090ef7970686ec6738a", sha256Hex(std::string(56, 'a')));
  TEST_ASSERT_EQUAL_STRING("7d3e74a05d7db15bce4ad9ec0658ea98e3f06eeecf16b4c6fff2da457ddc2f34", sha256Hex(std::string(63, 'a')));
  TEST_ASSERT_EQUAL_STRING("ffe054fe7ae0cb6dc65c3af9b61d5209f439851db43d0ba5997337df154668eb", sha256Hex(std::string(64, 'a')));
  TEST_ASSERT_EQUAL_STRING("635361c48bb9eab14198e76ea8ab7f1a41685d6ad62aa9146d301d4f17eb0ae0", sha256Hex(std::string(65, 'a')));
  TEST_ASSERT_EQUAL_STRING("31eba51c313a5c08226adf18d4a359cfdfd8d2e816b13f4af952f7ea6584dcfb", sha256Hex(std::string(119, 'a')));
  TEST_ASSERT_EQUAL_STRING("2f3d335432c70b580af0e8e1b3674a7c020d683aa5f73aaaedfdc55af904c21c", sha256Hex(std::string(120, 'a')));
}
void test_hmac_rfc4231() {
  std::string k1(20, '\x0b');
  TEST_ASSERT_EQUAL_STRING("b0344c61d8db38535ca8afceaf0bf12b881dc200c9833da726e9376c2e32cff7", hmacSha256Hex(k1, "Hi There"));
  TEST_ASSERT_EQUAL_STRING("5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843", hmacSha256Hex("Jefe", "what do ya want for nothing?"));
  TEST_ASSERT_EQUAL_STRING("773ea91e36800e46854db8ebd09181a72959098b3ef8c122d9635514ced565fe", hmacSha256Hex(std::string(20, '\xaa'), std::string(50, '\xdd')));
  TEST_ASSERT_EQUAL_STRING("60e431591ee0b67f0d8a26aacbf5b77f8e0bc6213728c5140546040f0ee37f54", hmacSha256Hex(std::string(131, '\xaa'), "Test Using Larger Than Block-Size Key - Hash Key First"));
}
void test_hex() {
  uint8_t b[4]; TEST_ASSERT_TRUE(fromHex("00ff10Ab", b, 4)); TEST_ASSERT_EQUAL_INT(0xab, b[3]);
  TEST_ASSERT_FALSE(fromHex("00ff10", b, 4)); TEST_ASSERT_FALSE(fromHex("zz000000", b, 4));
  TEST_ASSERT_EQUAL_STRING("00ff10ab", toHex(b, 4));
}

// ---------- JSON ----------
void test_json_basic() {
  JsonValue v; TEST_ASSERT_TRUE(JsonParser::parse("{\"a\":1,\"b\":[true,null,\"x\\n\\u00e9\"],\"c\":{\"d\":-12345678901234,\"e\":1.5}}", v));
  TEST_ASSERT_EQUAL_INT(1, v.integer("a")); TEST_ASSERT_EQUAL_INT(3, v.get("b")->arr.size()); TEST_ASSERT_TRUE(v.get("b")->arr[0].b);
  TEST_ASSERT_EQUAL_STRING("x\n\xc3\xa9", v.get("b")->arr[2].s); TEST_ASSERT_EQUAL_INT(-12345678901234LL, v.get("c")->integer("d"));
}
void test_json_rejects_garbage() {
  const char* bad[] = {"", "{", "{\"a\":}", "{\"a\":1,}", "[1,2", "{\"a\":1} x", "nul", "{'a':1}", "\"unterminated", "{\"a\":\"\\q\"}", "[01x]", "{\"a\" 1}"};
  for (auto s : bad) { JsonValue v; TEST_ASSERT_FALSE(JsonParser::parse(s, v)); }
  std::string deep(40, '['); deep += std::string(40, ']'); JsonValue v; TEST_ASSERT_FALSE(JsonParser::parse(deep, v));  // depth limit
}

// ---------- protocol: byte-for-byte compatibility with the TypeScript server ----------
static VendCommand cmdA() { VendCommand c; c.vendId = "b3b5c1f2-1111-4222-8333-444455556666"; c.tableId = "tbl-1"; c.deviceId = "dev_0123456789ab"; c.mode = "COIN_PULSE"; c.pulses = 2; c.pulseMs = 60; c.gapMs = 70; c.holdMs = 0;
  c.nonce = "00112233445566778899aabbccddeeff"; c.issuedAt = 1792000000000LL; c.expiresAt = 1792000030000LL; return c; }
void test_protocol_matches_server() {
  TEST_ASSERT_EQUAL_STRING(vec::CMD_STRING_A, commandString(cmdA()));
  TEST_ASSERT_EQUAL_STRING(vec::CMD_SIG_A, signCommand(cmdA(), vec::SECRET));
  TEST_ASSERT_EQUAL_STRING(vec::ACK_SIG, signAck("vend-1", "n-1", "ACK", 1792000005000LL, vec::SECRET));
  TEST_ASSERT_EQUAL_STRING(vec::ACK_SIG_CONFIRMED, signAck("vend-1", "n-1", "CONFIRMED", 1792000005000LL, vec::SECRET));
  TEST_ASSERT_EQUAL_STRING(vec::REQ_SIG, signRequest(vec::SECRET, "POST", "/api/device/sync", 1792000002000LL, vec::REQ_NONCE, vec::REQ_BODY));
  TEST_ASSERT_EQUAL_STRING(vec::SHA_OF_BODY, sha256Hex(vec::REQ_BODY));
  TEST_ASSERT_EQUAL_STRING(vec::RESP_SIG, signResponse(vec::SECRET, vec::REQ_NONCE, vec::RESP_BODY));
  TEST_ASSERT_TRUE(verifyResponse(vec::SECRET, vec::REQ_NONCE, vec::RESP_BODY, vec::RESP_SIG));
  TEST_ASSERT_FALSE(verifyResponse(vec::SECRET, vec::REQ_NONCE, vec::RESP_BODY + " ", vec::RESP_SIG));
  TEST_ASSERT_FALSE(verifyResponse(vec::SECRET, "otherotherotherotherotherother00", vec::RESP_BODY, vec::RESP_SIG));
  TEST_ASSERT_FALSE(verifyResponse("wrong-secret", vec::REQ_NONCE, vec::RESP_BODY, vec::RESP_SIG));
  TEST_ASSERT_FALSE(verifyResponse(vec::SECRET, vec::REQ_NONCE, vec::RESP_BODY, "nothex"));
}

// ---------- verifyCommand ----------
struct MemStore : PersistentSet::Store { std::string blob; std::string load() override { return blob; } void save(const std::string& b) override { blob = b; } };
void test_verify_command_all_outcomes() {
  PersistentSet n(16, nullptr); VendCommand c = cmdA(); std::string sig = vec::CMD_SIG_A; int64_t now = c.issuedAt + 1000;
  TEST_ASSERT_EQUAL_INT((int)Verify::Ok, (int)verifyCommand(c, sig, vec::SECRET, vec::DEVICE_ID, Mode::CoinPulse, now, n));
  TEST_ASSERT_EQUAL_INT((int)Verify::Replay, (int)verifyCommand(c, sig, vec::SECRET, vec::DEVICE_ID, Mode::CoinPulse, now, n));
  PersistentSet f(16, nullptr);
  TEST_ASSERT_EQUAL_INT((int)Verify::BadSignature, (int)verifyCommand(c, sig, "other-secret", vec::DEVICE_ID, Mode::CoinPulse, now, f));
  VendCommand t = c; t.pulses = 3; TEST_ASSERT_EQUAL_INT((int)Verify::BadSignature, (int)verifyCommand(t, sig, vec::SECRET, vec::DEVICE_ID, Mode::CoinPulse, now, f));
  t = c; t.holdMs = 1; TEST_ASSERT_EQUAL_INT((int)Verify::BadSignature, (int)verifyCommand(t, sig, vec::SECRET, vec::DEVICE_ID, Mode::CoinPulse, now, f));
  TEST_ASSERT_EQUAL_INT((int)Verify::BadFormat, (int)verifyCommand(c, "xyz", vec::SECRET, vec::DEVICE_ID, Mode::CoinPulse, now, f));
  TEST_ASSERT_EQUAL_INT((int)Verify::WrongDevice, (int)verifyCommand(c, sig, vec::SECRET, "dev_ffffffffffff", Mode::CoinPulse, now, f));
  TEST_ASSERT_EQUAL_INT((int)Verify::WrongMode, (int)verifyCommand(c, sig, vec::SECRET, vec::DEVICE_ID, Mode::GateSolenoid, now, f));
  TEST_ASSERT_EQUAL_INT((int)Verify::Expired, (int)verifyCommand(c, sig, vec::SECRET, vec::DEVICE_ID, Mode::CoinPulse, c.expiresAt + 5001, f));
  TEST_ASSERT_EQUAL_INT((int)Verify::NotYetValid, (int)verifyCommand(c, sig, vec::SECRET, vec::DEVICE_ID, Mode::CoinPulse, c.issuedAt - 5001, f));
  TEST_ASSERT_EQUAL_INT((int)Verify::Ok, (int)verifyCommand(c, sig, vec::SECRET, vec::DEVICE_ID, Mode::CoinPulse, c.expiresAt + 4999, f));  // inside drift tolerance
}
void test_verify_guard_limits_even_when_properly_signed() {
  for (int variant = 0; variant < 5; variant++) {
    VendCommand c = cmdA(); c.nonce = std::string(31, 'a') + (char)('0' + variant);
    if (variant == 0) c.pulses = 21; if (variant == 1) c.pulseMs = 1001; if (variant == 2) c.gapMs = 5; if (variant == 3) c.pulses = 0; if (variant == 4) c.pulseMs = 9;
    PersistentSet n(8, nullptr);
    TEST_ASSERT_EQUAL_INT((int)Verify::Guard, (int)verifyCommand(c, signCommand(c, vec::SECRET), vec::SECRET, vec::DEVICE_ID, Mode::CoinPulse, c.issuedAt, n));
  }
  VendCommand g = cmdA(); g.mode = "GATE_SOLENOID"; g.pulses = g.pulseMs = g.gapMs = 0; g.holdMs = 5001; g.nonce = std::string(32, 'b'); PersistentSet n(8, nullptr);
  TEST_ASSERT_EQUAL_INT((int)Verify::Guard, (int)verifyCommand(g, signCommand(g, vec::SECRET), vec::SECRET, vec::DEVICE_ID, Mode::GateSolenoid, g.issuedAt, n));
  g.holdMs = 5000; g.nonce = std::string(32, 'c'); TEST_ASSERT_EQUAL_INT((int)Verify::Ok, (int)verifyCommand(g, signCommand(g, vec::SECRET), vec::SECRET, vec::DEVICE_ID, Mode::GateSolenoid, g.issuedAt, n));
}
void test_failed_checks_do_not_burn_the_nonce() {
  PersistentSet n(8, nullptr); VendCommand c = cmdA();
  TEST_ASSERT_EQUAL_INT((int)Verify::Expired, (int)verifyCommand(c, vec::CMD_SIG_A, vec::SECRET, vec::DEVICE_ID, Mode::CoinPulse, c.expiresAt + 99999, n));
  TEST_ASSERT_FALSE(n.has(c.nonce));
}
void test_persistent_set_survives_reboot_and_evicts_oldest() {
  MemStore st; { PersistentSet s(3, &st); s.add("a"); s.add("b"); s.add("c"); s.add("d"); TEST_ASSERT_FALSE(s.has("a")); TEST_ASSERT_TRUE(s.has("d")); }
  PersistentSet again(3, &st); TEST_ASSERT_TRUE(again.has("b")); TEST_ASSERT_TRUE(again.has("c")); TEST_ASSERT_TRUE(again.has("d")); TEST_ASSERT_EQUAL_INT(3, again.size());
  again.add("c"); TEST_ASSERT_EQUAL_INT(3, again.size());
}

// ---------- sequencer ----------
struct FakeOut : IOutput { bool on = false; std::vector<std::pair<uint32_t, bool>> log; uint32_t* clock = nullptr; void set(bool v) override { on = v; log.push_back({clock ? *clock : 0, v}); } };
void test_sequencer_starts_off_and_times_coin_pulses_exactly() {
  uint32_t now = 1000; FakeOut o; o.clock = &now; o.on = true; VendSequencer s(o);
  TEST_ASSERT_FALSE(o.on);  // fail-safe default at construction
  VendCommand c = cmdA(); TEST_ASSERT_TRUE(s.start(c, now)); TEST_ASSERT_TRUE(o.on);
  std::vector<std::pair<uint32_t, bool>> edges; bool last = o.on; edges.push_back({now, true});
  for (; now < 1500; now++) { s.tick(now); if (o.on != last) { edges.push_back({now, o.on}); last = o.on; } }
  // 2 pulses: ON 60 ms, OFF 70 ms, ON 60 ms, OFF  -> edges at +0 (on), +60 (off), +130 (on), +190 (off)
  TEST_ASSERT_EQUAL_INT(4, edges.size()); TEST_ASSERT_EQUAL_INT(1000, edges[0].first); TEST_ASSERT_EQUAL_INT(1060, edges[1].first); TEST_ASSERT_EQUAL_INT(1130, edges[2].first); TEST_ASSERT_EQUAL_INT(1190, edges[3].first);
  bool faulted = true; TEST_ASSERT_TRUE(s.takeFinished(&faulted)); TEST_ASSERT_FALSE(faulted); TEST_ASSERT_FALSE(s.takeFinished(nullptr));
}
void test_sequencer_solenoid_hold_and_busy_rejection() {
  uint32_t now = 0; FakeOut o; VendSequencer s(o); VendCommand c = cmdA(); c.mode = "GATE_SOLENOID"; c.holdMs = 1500; c.pulses = c.pulseMs = c.gapMs = 0;
  TEST_ASSERT_TRUE(s.start(c, now)); TEST_ASSERT_FALSE(s.start(c, now)); s.tick(1499); TEST_ASSERT_TRUE(o.on); s.tick(1500); TEST_ASSERT_FALSE(o.on);
}
void test_sequencer_millis_rollover() {
  uint32_t now = 0xFFFFFF00u; FakeOut o; VendSequencer s(o); VendCommand c = cmdA(); c.pulses = 1; c.pulseMs = 600;
  TEST_ASSERT_TRUE(s.start(c, now)); s.tick(now + 500); TEST_ASSERT_TRUE(o.on);  // crosses the 2^32 boundary
  s.tick(now + 600); TEST_ASSERT_FALSE(o.on); TEST_ASSERT_TRUE(s.takeFinished(nullptr));
}
void test_sequencer_rejects_dangerous_parameters_and_keeps_output_off() {
  FakeOut o; VendSequencer s(o); VendCommand c = cmdA(); c.mode = "GATE_SOLENOID"; c.holdMs = 60000; c.pulses = c.pulseMs = c.gapMs = 0;
  TEST_ASSERT_FALSE(s.start(c, 0)); TEST_ASSERT_FALSE(o.on); c.holdMs = 10; TEST_ASSERT_FALSE(s.start(c, 0)); c.mode = "NOPE"; c.holdMs = 500; TEST_ASSERT_FALSE(s.start(c, 0)); TEST_ASSERT_FALSE(o.on);
}
void test_sequencer_independent_on_time_watchdog_forces_off() {
  FakeOut o; VendSequencer s(o); VendCommand c = cmdA(); c.mode = "GATE_SOLENOID"; c.holdMs = 5000; c.pulses = c.pulseMs = c.gapMs = 0; TEST_ASSERT_TRUE(s.start(c, 0));
  s.tick(5001 + 100);  // simulates the main loop being stalled for ages: output must still be forced off
  TEST_ASSERT_FALSE(o.on); bool faulted = false; TEST_ASSERT_TRUE(s.takeFinished(&faulted)); TEST_ASSERT_TRUE(faulted);
}
void test_sequencer_abort() { FakeOut o; VendSequencer s(o); TEST_ASSERT_TRUE(s.start(cmdA(), 0)); s.abort(); TEST_ASSERT_FALSE(o.on); TEST_ASSERT_FALSE(s.busy()); }

// ---------- coin counter / debouncer ----------
static void pulse(CoinCounter& c, uint32_t t, uint32_t width) { c.onEdge(true, t); c.onEdge(false, t + width); }
void test_coin_counter_counts_valid_pulses() { CoinCounter c; pulse(c, 100000, 40000); pulse(c, 400000, 40000); pulse(c, 900000, 40000); TEST_ASSERT_EQUAL_INT(3, c.takeCoins()); TEST_ASSERT_EQUAL_INT(0, c.takeCoins()); }
void test_coin_counter_rejects_noise_bounce_and_bad_widths() {
  CoinCounter c; pulse(c, 100000, 2000);   // glitch: too short
  pulse(c, 200000, 500000);                // stuck / too long
  TEST_ASSERT_EQUAL_INT(0, c.takeCoins()); TEST_ASSERT_EQUAL_INT(2, c.rejectedEdges());
  // one real pulse with contact bounce at its start: must count exactly ONE coin, never two
  c.onEdge(true, 300000); c.onEdge(false, 300500); c.onEdge(true, 301000); c.onEdge(false, 340000);
  TEST_ASSERT_EQUAL_INT(1, c.takeCoins()); TEST_ASSERT_EQUAL_INT(4, c.rejectedEdges());
  CoinCounter e; e.onEdge(false, 5000); TEST_ASSERT_EQUAL_INT(0, e.takeCoins());  // a lone falling edge is ignored
  CoinCounter w; pulse(w, 10000, 14999); pulse(w, 100000, 15000); pulse(w, 200000, 150000); pulse(w, 400000, 150001);  // width limits are inclusive
  TEST_ASSERT_EQUAL_INT(2, w.takeCoins());
}
void test_coin_counter_pulses_per_coin_and_rollover() {
  CoinCounter c(3000, 15000, 150000, 2); pulse(c, 0xFFFFF000u, 40000); pulse(c, 0xFFFFF000u + 200000, 40000); pulse(c, 700000, 40000); TEST_ASSERT_EQUAL_INT(1, c.takeCoins());  // 2 pulses = 1 coin, third pending; works across 2^32
  pulse(c, 1000000, 40000); TEST_ASSERT_EQUAL_INT(1, c.takeCoins());
}
void test_debouncer() {
  Debouncer d(50, false); TEST_ASSERT_FALSE(d.update(true, 0)); TEST_ASSERT_FALSE(d.update(false, 20)); TEST_ASSERT_FALSE(d.update(true, 30)); TEST_ASSERT_FALSE(d.update(true, 70)); TEST_ASSERT_FALSE(d.state());
  TEST_ASSERT_TRUE(d.update(true, 80)); TEST_ASSERT_TRUE(d.state()); TEST_ASSERT_FALSE(d.update(true, 200));
}

// ---------- DeviceCore end to end (server-generated responses) ----------
struct Rig { FakeOut out; VendSequencer seq; MemStore nStore, eStore; PersistentSet nonces, executed; DeviceCore core;
  Rig(Mode m = Mode::CoinPulse) : seq(out), nonces(32, &nStore), executed(32, &eStore), core(vec::DEVICE_ID, vec::SECRET, m, seq, nonces, executed) {} };
static int countOn(const FakeOut& o) { int n = 0; for (auto& e : o.log) if (e.second) n++; return n; }
static void runFor(Rig& r, uint32_t& now, uint32_t ms) { for (uint32_t i = 0; i < ms; i++) { r.core.tick(now++); } }

void test_core_executes_valid_commands_rejects_forged_expired_and_dedupes() {
  Rig r; uint32_t now = 5000;
  // response contains: A, A again (same nonce = replay), a command altered after signing, an expired command, B
  TEST_ASSERT_TRUE(r.core.handleResponse(vec::RESP_BODY, vec::RESP_SIG, vec::REQ_NONCE, 1792000001000LL, now));
  TEST_ASSERT_EQUAL_INT(1792000001000LL - 5000, r.core.serverOffsetMs());
  runFor(r, now, 600);  // A (2 pulses) then B (1 pulse) run one after the other
  TEST_ASSERT_EQUAL_INT(3, countOn(r.out));  // 2 + 1 pulses: forged/expired/replayed produced NOTHING
  TEST_ASSERT_EQUAL_INT(3, r.core.rejectedCount());  // replay, forged, expired
  std::vector<PendingAck> acks; std::vector<PendingEvent> ev; std::string body = r.core.buildSync(Telemetry{}, 0, now, &acks, &ev);
  TEST_ASSERT_EQUAL_INT(2, acks.size()); TEST_ASSERT_EQUAL_STRING("ACK", acks[0].status);
  JsonValue j; TEST_ASSERT_TRUE(JsonParser::parse(body, j)); TEST_ASSERT_EQUAL_INT(2, j.get("acks")->arr.size());
  const JsonValue& a0 = j.get("acks")->arr[0]; TEST_ASSERT_EQUAL_STRING(signAck(a0.str("vendId"), a0.str("nonce"), a0.str("status"), a0.integer("ts"), vec::SECRET), a0.str("signature"));
}
void test_core_resend_after_reboot_never_vends_twice() {
  Rig r; uint32_t now = 0; r.core.handleResponse(vec::RESP_BODY, vec::RESP_SIG, vec::REQ_NONCE, 1792000001000LL, now); runFor(r, now, 600); int first = countOn(r.out); TEST_ASSERT_EQUAL_INT(3, first);
  // power cycle: RAM is gone, persistent stores (nonces + executed vend IDs) survive
  FakeOut out2; VendSequencer seq2(out2); PersistentSet n2(32, &r.nStore), e2(32, &r.eStore); DeviceCore core2(vec::DEVICE_ID, vec::SECRET, Mode::CoinPulse, seq2, n2, e2);
  // the server re-issues the same vend IDs with FRESH nonces (what happens after a lost ack)
  VendCommand a = cmdA(); a.nonce = "99999999999999999999999999999999"; a.issuedAt = 1792000001000LL; a.expiresAt = 1792000031000LL;
  std::string body = std::string("{\"commands\":[{\"command\":{\"vendId\":\"") + a.vendId + "\",\"tableId\":\"tbl-1\",\"deviceId\":\"dev_0123456789ab\",\"mode\":\"COIN_PULSE\",\"pulses\":2,\"pulseMs\":60,\"gapMs\":70,\"holdMs\":0,\"nonce\":\"" + a.nonce + "\",\"issuedAt\":1792000001000,\"expiresAt\":1792000031000},\"signature\":\"" + signCommand(a, vec::SECRET) + "\"}],\"ackResults\":[],\"config\":{}}";
  TEST_ASSERT_TRUE(core2.handleResponse(body, signResponse(vec::SECRET, "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", body), "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", 1792000002000LL, 10));
  for (uint32_t t = 10; t < 700; t++) core2.tick(t);
  TEST_ASSERT_EQUAL_INT(0, countOn(out2)); std::vector<PendingAck> acks; std::vector<PendingEvent> ev; core2.buildSync(Telemetry{}, 0, 800, &acks, &ev);
  TEST_ASSERT_EQUAL_INT(1, acks.size()); TEST_ASSERT_EQUAL_STRING("ACK", acks[0].status); TEST_ASSERT_EQUAL_STRING(a.nonce, acks[0].nonce);  // re-acknowledged, not re-vended
}
void test_core_ignores_unauthenticated_responses() {
  Rig r; uint32_t now = 0;
  TEST_ASSERT_FALSE(r.core.handleResponse(vec::RESP_BODY, std::string(64, '0'), vec::REQ_NONCE, 1792000001000LL, now));
  TEST_ASSERT_FALSE(r.core.handleResponse(vec::RESP_BODY, vec::RESP_SIG, "ffffffffffffffffffffffffffffffff", 1792000001000LL, now));  // response bound to a different request
  runFor(r, now, 600); TEST_ASSERT_EQUAL_INT(0, countOn(r.out)); TEST_ASSERT_EQUAL_INT(0, r.core.serverOffsetMs());
}
void test_core_gate_mode_and_mode_mismatch() {
  Rig g(Mode::GateSolenoid); uint32_t now = 0;
  TEST_ASSERT_TRUE(g.core.handleResponse(vec::GATE_BODY, vec::GATE_RESP_SIG, vec::REQ_NONCE, 1792000001000LL, now));
  for (uint32_t i = 0; i < 100; i++) g.core.tick(now++); TEST_ASSERT_TRUE(g.out.on); for (uint32_t i = 0; i < 1500; i++) g.core.tick(now++); TEST_ASSERT_FALSE(g.out.on); TEST_ASSERT_EQUAL_INT(1, countOn(g.out));
  Rig wrong(Mode::CoinPulse); now = 0; wrong.core.handleResponse(vec::GATE_BODY, vec::GATE_RESP_SIG, vec::REQ_NONCE, 1792000001000LL, now); runFor(wrong, now, 2000);
  TEST_ASSERT_EQUAL_INT(0, countOn(wrong.out)); TEST_ASSERT_EQUAL_STRING("MODE_MISMATCH", wrong.core.lastRejectReason());
}
void test_core_adopts_vend_mode_from_authenticated_config() {
  Rig r(Mode::CoinPulse); uint32_t now = 0; TEST_ASSERT_TRUE(r.core.handleResponse(vec::GATE_BODY, vec::GATE_RESP_SIG, vec::REQ_NONCE, 1792000001000LL, now));
  TEST_ASSERT_EQUAL_INT((int)Mode::CoinPulse, (int)r.core.mode());  // GATE_BODY carries an empty config: mode unchanged
  std::string body = "{\"commands\":[],\"ackResults\":[],\"config\":{\"vendMode\":\"SOLENOID_SLIDE\"}}"; std::string sig = signResponse(vec::SECRET, vec::REQ_NONCE, body);
  TEST_ASSERT_TRUE(r.core.handleResponse(body, sig, vec::REQ_NONCE, 1792000001000LL, now)); TEST_ASSERT_EQUAL_INT((int)Mode::SolenoidSlide, (int)r.core.mode());
  TEST_ASSERT_FALSE(r.core.handleResponse(body, std::string(64, 'a'), vec::REQ_NONCE, 1792000001000LL, now));  // an unauthenticated config can never change the mode
}
void test_core_sync_body_events_and_ack_restore() {
  Rig r; r.core.queueCoinEvent("coin-1", 2); r.core.queueEvent("tamper-1", "tamper"); r.core.queueConfirmed("v-1", "n-1");
  Telemetry t; t.fw = "1.0.0"; t.uptimeS = 42; t.rssi = -61; t.freeHeap = 123456; t.resetReason = "brownout"; t.ready = false; t.tamper = true;
  std::vector<PendingAck> a; std::vector<PendingEvent> e; std::string body = r.core.buildSync(t, 20, 1000, &a, &e);
  JsonValue j; TEST_ASSERT_TRUE(JsonParser::parse(body, j)); TEST_ASSERT_EQUAL_INT(20, j.integer("wait")); TEST_ASSERT_EQUAL_STRING("brownout", j.str("resetReason"));
  TEST_ASSERT_FALSE(j.get("sensors")->boolean("ready")); TEST_ASSERT_TRUE(j.get("sensors")->boolean("tamper")); TEST_ASSERT_EQUAL_INT(2, j.get("events")->arr.size());
  TEST_ASSERT_EQUAL_INT(2, j.get("events")->arr[0].get("data")->integer("coins"));
  TEST_ASSERT_EQUAL_STRING("CONFIRMED", j.get("acks")->arr[0].str("status"));
  TEST_ASSERT_FALSE(r.core.hasPendingWork());
  r.core.restoreAcks(a, e);  // network failed: nothing may be lost
  TEST_ASSERT_TRUE(r.core.hasPendingWork()); std::vector<PendingAck> a2; std::vector<PendingEvent> e2; r.core.buildSync(t, 0, 2000, &a2, &e2); TEST_ASSERT_EQUAL_INT(1, a2.size()); TEST_ASSERT_EQUAL_INT(2, e2.size());
}

int main() {
  UNITY_BEGIN();
  RUN_TEST(test_sha256_known); RUN_TEST(test_sha256_block_boundaries_and_streaming); RUN_TEST(test_hmac_rfc4231); RUN_TEST(test_hex);
  RUN_TEST(test_json_basic); RUN_TEST(test_json_rejects_garbage);
  RUN_TEST(test_protocol_matches_server); RUN_TEST(test_verify_command_all_outcomes); RUN_TEST(test_verify_guard_limits_even_when_properly_signed); RUN_TEST(test_failed_checks_do_not_burn_the_nonce); RUN_TEST(test_persistent_set_survives_reboot_and_evicts_oldest);
  RUN_TEST(test_sequencer_starts_off_and_times_coin_pulses_exactly); RUN_TEST(test_sequencer_solenoid_hold_and_busy_rejection); RUN_TEST(test_sequencer_millis_rollover); RUN_TEST(test_sequencer_rejects_dangerous_parameters_and_keeps_output_off); RUN_TEST(test_sequencer_independent_on_time_watchdog_forces_off); RUN_TEST(test_sequencer_abort);
  RUN_TEST(test_coin_counter_counts_valid_pulses); RUN_TEST(test_coin_counter_rejects_noise_bounce_and_bad_widths); RUN_TEST(test_coin_counter_pulses_per_coin_and_rollover); RUN_TEST(test_debouncer);
  RUN_TEST(test_core_executes_valid_commands_rejects_forged_expired_and_dedupes); RUN_TEST(test_core_resend_after_reboot_never_vends_twice); RUN_TEST(test_core_ignores_unauthenticated_responses); RUN_TEST(test_core_gate_mode_and_mode_mismatch); RUN_TEST(test_core_adopts_vend_mode_from_authenticated_config); RUN_TEST(test_core_sync_body_events_and_ack_restore);
  return UNITY_END();
}
