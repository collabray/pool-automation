#pragma once
// Wire protocol shared with the server (src/core/command.ts and src/core/devices.ts). Strings are byte-for-byte identical.
#include <cstdint>
#include <deque>
#include <string>
#include "sha256.h"

namespace pt {
enum class Mode { CoinPulse, SolenoidSlide, GateSolenoid, Unknown };
Mode modeFromString(const std::string& s);

struct VendCommand {
  std::string vendId, tableId, deviceId, mode, nonce;
  int pulses = 0, pulseMs = 0, gapMs = 0, holdMs = 0;
  int64_t issuedAt = 0, expiresAt = 0;  // server epoch ms
};

// Hard safety limits. Enforced here AND by the output driver, independently of anything the server says.
constexpr int kMaxPulses = 20, kMaxPulseMs = 1000, kMaxGapMs = 1000, kMaxHoldMs = 5000, kMinOnMs = 10;
constexpr uint32_t kAbsoluteMaxOnMs = 5000;

enum class Verify { Ok, BadFormat, BadSignature, Expired, NotYetValid, Replay, WrongDevice, WrongMode, Guard };
const char* verifyName(Verify v);

std::string commandString(const VendCommand& c);
std::string signCommand(const VendCommand& c, const std::string& secret);
std::string ackString(const std::string& vendId, const std::string& nonce, const std::string& status, int64_t ts);
std::string signAck(const std::string& vendId, const std::string& nonce, const std::string& status, int64_t ts, const std::string& secret);
std::string signRequest(const std::string& secret, const std::string& method, const std::string& path, int64_t ts, const std::string& nonce, const std::string& body);
std::string signResponse(const std::string& secret, const std::string& nonce, const std::string& body);
bool verifyResponse(const std::string& secret, const std::string& nonce, const std::string& body, const std::string& sigHex);

/** Bounded set of remembered strings that survives reboot through a Persistence callback pair. */
class PersistentSet {
 public:
  struct Store { virtual ~Store() {} virtual std::string load() = 0; virtual void save(const std::string& blob) = 0; };
  PersistentSet(size_t capacity, Store* store) : cap_(capacity), store_(store) { if (store_) restore(store_->load()); }
  bool has(const std::string& k) const { for (auto& x : items_) if (x == k) return true; return false; }
  void add(const std::string& k) { if (has(k)) return; items_.push_back(k); while (items_.size() > cap_) items_.pop_front(); if (store_) store_->save(serialize()); }
  size_t size() const { return items_.size(); }
 private:
  size_t cap_; Store* store_; std::deque<std::string> items_;
  std::string serialize() const { std::string s; for (auto& x : items_) { s += x; s += '\n'; } return s; }
  void restore(const std::string& blob) { std::string cur; for (char c : blob) { if (c == '\n') { if (!cur.empty()) items_.push_back(cur); cur.clear(); } else cur += c; } while (items_.size() > cap_) items_.pop_front(); }
};

/** Signature -> expiry (with drift tolerance, against SERVER time) -> nonce replay. The nonce is recorded only when everything else passes. */
Verify verifyCommand(const VendCommand& c, const std::string& sigHex, const std::string& secret, const std::string& myDeviceId,
                     Mode myMode, int64_t serverNowMs, PersistentSet& nonces, int64_t driftMs = 5000);
}  // namespace pt
