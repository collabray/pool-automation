#pragma once
// Non-blocking output sequencer. The output is forced OFF at construction, on abort, on any fault, and whenever the
// on-time would exceed the absolute hard limit, so a software bug can never hold a solenoid energised.
#include <cstdint>
#include "protocol.h"

namespace pt {
struct IOutput { virtual ~IOutput() {} virtual void set(bool on) = 0; };

class VendSequencer {
 public:
  enum class State { Idle, On, Gap, Done, Fault };
  explicit VendSequencer(IOutput& out) : out_(out) { out_.set(false); }
  /** Starts a sequence. Returns false (output stays off) if busy or the parameters violate the hard limits. */
  bool start(const VendCommand& c, uint32_t nowMs);
  void tick(uint32_t nowMs);
  void abort() { force_off(); state_ = State::Idle; }
  bool busy() const { return state_ == State::On || state_ == State::Gap; }
  State state() const { return state_; }
  /** Returns true once after a sequence finished (Done) or faulted; resets to Idle. */
  bool takeFinished(bool* faulted) { if (state_ == State::Done || state_ == State::Fault) { if (faulted) *faulted = state_ == State::Fault; state_ = State::Idle; return true; } return false; }
  uint32_t onSinceMs() const { return onSince_; }
 private:
  IOutput& out_; State state_ = State::Idle; Mode mode_ = Mode::Unknown;
  int pulsesLeft_ = 0; uint32_t pulseMs_ = 0, gapMs_ = 0, holdMs_ = 0, phaseStart_ = 0, onSince_ = 0; bool outOn_ = false;
  void force_off() { out_.set(false); outOn_ = false; }
  void on(uint32_t now) { out_.set(true); outOn_ = true; onSince_ = now; phaseStart_ = now; state_ = State::On; }
};
}  // namespace pt
