#include "vend_sequencer.h"

namespace pt {
bool VendSequencer::start(const VendCommand& c, uint32_t now) {
  if (busy()) return false;
  Mode m = modeFromString(c.mode);
  if (m == Mode::CoinPulse) {
    if (c.pulses < 1 || c.pulses > kMaxPulses || c.pulseMs < kMinOnMs || c.pulseMs > kMaxPulseMs || c.gapMs < kMinOnMs || c.gapMs > kMaxGapMs) { force_off(); return false; }
    pulsesLeft_ = c.pulses; pulseMs_ = (uint32_t)c.pulseMs; gapMs_ = (uint32_t)c.gapMs; holdMs_ = 0;
  } else if (m == Mode::SolenoidSlide || m == Mode::GateSolenoid) {
    if (c.holdMs < 50 || c.holdMs > kMaxHoldMs) { force_off(); return false; }
    pulsesLeft_ = 1; holdMs_ = (uint32_t)c.holdMs; pulseMs_ = holdMs_; gapMs_ = 0;
  } else { force_off(); return false; }
  mode_ = m; on(now); return true;
}
void VendSequencer::tick(uint32_t now) {
  if (outOn_ && (uint32_t)(now - onSince_) > kAbsoluteMaxOnMs) { force_off(); state_ = State::Fault; return; }  // independent watchdog on the output
  if (state_ == State::On) {
    if ((uint32_t)(now - phaseStart_) >= pulseMs_) {
      force_off(); pulsesLeft_--;
      if (pulsesLeft_ <= 0) { state_ = State::Done; return; }
      state_ = State::Gap; phaseStart_ = now;
    }
  } else if (state_ == State::Gap) {
    if ((uint32_t)(now - phaseStart_) >= gapMs_) on(now);
  }
}
}  // namespace pt
