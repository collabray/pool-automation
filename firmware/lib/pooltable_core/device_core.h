#pragma once
// Platform-independent device brain: builds sync requests, authenticates responses, verifies and executes commands via the sequencer.
#include <cstdint>
#include <string>
#include <vector>
#include "mini_json.h"
#include "protocol.h"
#include "vend_sequencer.h"

namespace pt {
struct Telemetry { std::string fw; int64_t uptimeS = 0; int rssi = 0; int64_t freeHeap = 0; std::string resetReason; bool ready = true; bool tamper = false; };
struct PendingAck { std::string vendId, nonce, status; };
struct PendingEvent { std::string id, kind; int coins = 0; };

class DeviceCore {
 public:
  DeviceCore(std::string deviceId, std::string secret, Mode mode, VendSequencer& seq, PersistentSet& nonces, PersistentSet& executed)
      : id_(std::move(deviceId)), secret_(std::move(secret)), mode_(mode), seq_(seq), nonces_(nonces), executed_(executed) {}

  /** JSON body for POST /api/device/sync. Acks are signed here. Pending acks are moved into the request (call restoreAcks on network failure). */
  std::string buildSync(const Telemetry& t, int waitSec, int64_t nowMs, std::vector<PendingAck>* sentAcks, std::vector<PendingEvent>* sentEvents);
  void restoreAcks(const std::vector<PendingAck>& a, const std::vector<PendingEvent>& e) { for (auto& x : a) acks_.push_back(x); for (auto& x : e) events_.push_back(x); }

  /** Authenticates and processes the server response. Returns false (and does nothing) if the response signature is wrong. */
  bool handleResponse(const std::string& body, const std::string& respSigHex, const std::string& requestNonce, int64_t serverTimeMs, uint32_t nowMs);

  /** Call every loop: drives the output and queues the ack when a sequence completes. */
  void tick(uint32_t nowMs);
  void queueCoinEvent(const std::string& eventId, int coins) { PendingEvent e; e.id = eventId; e.kind = "coin"; e.coins = coins; events_.push_back(e); }
  void queueEvent(const std::string& id, const std::string& kind) { PendingEvent e; e.id = id; e.kind = kind; events_.push_back(e); }
  void queueConfirmed(const std::string& vendId, const std::string& nonce) { acks_.push_back({vendId, nonce, "CONFIRMED"}); }

  Mode mode() const { return mode_; }
  int64_t serverOffsetMs() const { return offset_; }
  int rejectedCount() const { return rejected_; }
  const std::string& lastRejectReason() const { return lastReject_; }
  bool hasPendingWork() const { return !acks_.empty() || !events_.empty() || seq_.busy(); }
  const std::string& deviceId() const { return id_; }
  const std::string& secret() const { return secret_; }
 private:
  std::string id_, secret_; Mode mode_; VendSequencer& seq_; PersistentSet& nonces_; PersistentSet& executed_;
  std::vector<PendingAck> acks_; std::vector<PendingEvent> events_; std::vector<VendCommand> waiting_;
  int64_t offset_ = 0; int rejected_ = 0; std::string lastReject_; std::string activeVend_, activeNonce_; 
  void startOrQueue(const VendCommand& c, uint32_t nowMs);
};
}  // namespace pt
