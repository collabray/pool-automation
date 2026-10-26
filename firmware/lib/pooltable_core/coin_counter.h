#pragma once
// Coin acceptor pulse counter with debouncing and pulse-width validation. Feed it every edge (from an ISR timestamp queue).
#include <cstdint>

namespace pt {
class CoinCounter {
 public:
  /** debounceUs: ignore edges closer than this to the previous accepted edge. Valid pulse width: [minPulseUs, maxPulseUs]. */
  CoinCounter(uint32_t debounceUs = 3000, uint32_t minPulseUs = 15000, uint32_t maxPulseUs = 150000, uint8_t pulsesPerCoin = 1)
      : debounce_(debounceUs), minW_(minPulseUs), maxW_(maxPulseUs), ppc_(pulsesPerCoin ? pulsesPerCoin : 1) {}
  /** level: true when the line is in its ACTIVE state after this edge. */
  void onEdge(bool level, uint32_t tUs) {
    if (haveEdge_ && (uint32_t)(tUs - lastAccepted_) < debounce_) { rejected_++; return; }
    haveEdge_ = true; lastAccepted_ = tUs;
    if (level) { if (!active_) { active_ = true; riseAt_ = tUs; } return; }
    if (!active_) return;
    active_ = false; uint32_t w = tUs - riseAt_;
    if (w < minW_ || w > maxW_) { rejected_++; return; }
    if (++pulses_ >= ppc_) { pulses_ = 0; coins_++; }
  }
  uint32_t takeCoins() { uint32_t c = coins_; coins_ = 0; return c; }
  uint32_t rejectedEdges() const { return rejected_; }
 private:
  uint32_t debounce_, minW_, maxW_; uint8_t ppc_;
  bool haveEdge_ = false, active_ = false; uint32_t lastAccepted_ = 0, riseAt_ = 0, coins_ = 0, rejected_ = 0; uint8_t pulses_ = 0;
};

/** Time-based debouncer for switches (balls-captured sensor, tamper switch). */
class Debouncer {
 public:
  explicit Debouncer(uint32_t stableMs = 50, bool initial = false) : stable_(stableMs), state_(initial), candidate_(initial) {}
  /** Returns true when the debounced state changed on this call. */
  bool update(bool raw, uint32_t nowMs) {
    if (raw != candidate_) { candidate_ = raw; since_ = nowMs; return false; }
    if (candidate_ != state_ && (uint32_t)(nowMs - since_) >= stable_) { state_ = candidate_; return true; }
    return false;
  }
  bool state() const { return state_; }
 private:
  uint32_t stable_; bool state_, candidate_; uint32_t since_ = 0;
};
}  // namespace pt
