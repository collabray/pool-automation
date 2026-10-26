#include "protocol.h"

namespace pt {
Mode modeFromString(const std::string& s) {
  if (s == "COIN_PULSE") return Mode::CoinPulse; if (s == "SOLENOID_SLIDE") return Mode::SolenoidSlide; if (s == "GATE_SOLENOID") return Mode::GateSolenoid; return Mode::Unknown;
}
const char* verifyName(Verify v) {
  switch (v) { case Verify::Ok: return "OK"; case Verify::BadFormat: return "BAD_FORMAT"; case Verify::BadSignature: return "BAD_SIGNATURE"; case Verify::Expired: return "EXPIRED"; case Verify::NotYetValid: return "NOT_YET_VALID";
    case Verify::Replay: return "REPLAY"; case Verify::WrongDevice: return "WRONG_DEVICE"; case Verify::WrongMode: return "MODE_MISMATCH"; case Verify::Guard: return "GUARD"; }
  return "?";
}
std::string commandString(const VendCommand& c) {
  return "v1|" + c.vendId + "|" + c.tableId + "|" + c.deviceId + "|" + c.mode + "|" + std::to_string(c.pulses) + "|" + std::to_string(c.pulseMs) + "|" + std::to_string(c.gapMs) + "|" +
         std::to_string(c.holdMs) + "|" + c.nonce + "|" + std::to_string(c.issuedAt) + "|" + std::to_string(c.expiresAt);
}
std::string signCommand(const VendCommand& c, const std::string& secret) { return hmacSha256Hex(secret, commandString(c)); }
std::string ackString(const std::string& v, const std::string& n, const std::string& st, int64_t ts) { return "ack1|" + v + "|" + n + "|" + st + "|" + std::to_string(ts); }
std::string signAck(const std::string& v, const std::string& n, const std::string& st, int64_t ts, const std::string& secret) { return hmacSha256Hex(secret, ackString(v, n, st, ts)); }
std::string signRequest(const std::string& secret, const std::string& method, const std::string& path, int64_t ts, const std::string& nonce, const std::string& body) {
  return hmacSha256Hex(secret, method + "\n" + path + "\n" + std::to_string(ts) + "\n" + nonce + "\n" + sha256Hex(body));
}
std::string signResponse(const std::string& secret, const std::string& nonce, const std::string& body) { return hmacSha256Hex(secret, "resp\n" + nonce + "\n" + sha256Hex(body)); }
bool verifyResponse(const std::string& secret, const std::string& nonce, const std::string& body, const std::string& sigHex) {
  uint8_t want[32], got[32]; std::string w = signResponse(secret, nonce, body); if (!fromHex(w, want, 32) || !fromHex(sigHex, got, 32)) return false; return constTimeEqual(want, got, 32);
}

static bool isHex(const std::string& s, size_t n) { if (s.size() != n) return false; for (char c : s) if (!((c >= '0' && c <= '9') || (c >= 'a' && c <= 'f'))) return false; return true; }

Verify verifyCommand(const VendCommand& c, const std::string& sigHex, const std::string& secret, const std::string& myDeviceId, Mode myMode, int64_t now, PersistentSet& nonces, int64_t drift) {
  if (!isHex(c.nonce, 32) || !isHex(sigHex, 64) || c.vendId.empty() || c.vendId.size() > 60) return Verify::BadFormat;
  uint8_t want[32], got[32];
  if (!fromHex(signCommand(c, secret), want, 32) || !fromHex(sigHex, got, 32) || !constTimeEqual(want, got, 32)) return Verify::BadSignature;
  if (c.deviceId != myDeviceId) return Verify::WrongDevice;
  if (now > c.expiresAt + drift) return Verify::Expired;
  if (now < c.issuedAt - drift) return Verify::NotYetValid;
  Mode m = modeFromString(c.mode);
  if (m == Mode::Unknown || m != myMode) return Verify::WrongMode;
  if (m == Mode::CoinPulse) { if (c.pulses < 1 || c.pulses > kMaxPulses || c.pulseMs < kMinOnMs || c.pulseMs > kMaxPulseMs || c.gapMs < kMinOnMs || c.gapMs > kMaxGapMs) return Verify::Guard; }
  else if (c.holdMs < 50 || c.holdMs > kMaxHoldMs) return Verify::Guard;
  if (nonces.has(c.nonce)) return Verify::Replay;
  nonces.add(c.nonce);
  return Verify::Ok;
}
}  // namespace pt
