#include "device_core.h"

namespace pt {
static std::string jq(const std::string& s) { std::string o = "\""; for (char c : s) { if (c == '"' || c == '\\') { o += '\\'; o += c; } else if ((unsigned char)c < 0x20) o += ' '; else o += c; } return o + "\""; }

std::string DeviceCore::buildSync(const Telemetry& t, int waitSec, int64_t nowMs, std::vector<PendingAck>* sentAcks, std::vector<PendingEvent>* sentEvents) {
  std::string j = "{\"fw\":" + jq(t.fw) + ",\"uptimeS\":" + std::to_string(t.uptimeS) + ",\"rssi\":" + std::to_string(t.rssi) + ",\"freeHeap\":" + std::to_string(t.freeHeap) +
                  ",\"resetReason\":" + jq(t.resetReason) + ",\"sensors\":{\"ready\":" + (t.ready ? "true" : "false") + ",\"tamper\":" + (t.tamper ? "true" : "false") + "},\"wait\":" + std::to_string(waitSec) + ",\"acks\":[";
  bool first = true;
  for (auto& a : acks_) { if (!first) j += ","; first = false; int64_t ts = nowMs + offset_;
    j += "{\"vendId\":" + jq(a.vendId) + ",\"nonce\":" + jq(a.nonce) + ",\"status\":" + jq(a.status) + ",\"ts\":" + std::to_string(ts) + ",\"signature\":\"" + signAck(a.vendId, a.nonce, a.status, ts, secret_) + "\"}"; }
  j += "],\"events\":[";
  first = true;
  for (auto& e : events_) { if (!first) j += ","; first = false; j += "{\"id\":" + jq(e.id) + ",\"kind\":" + jq(e.kind); if (e.kind == "coin") j += ",\"data\":{\"coins\":" + std::to_string(e.coins) + "}"; j += "}"; }
  j += "]}";
  if (sentAcks) *sentAcks = acks_; if (sentEvents) *sentEvents = events_;
  acks_.clear(); events_.clear();
  return j;
}

bool DeviceCore::handleResponse(const std::string& body, const std::string& respSig, const std::string& reqNonce, int64_t serverTimeMs, uint32_t nowMs) {
  if (!verifyResponse(secret_, reqNonce, body, respSig)) return false;  // never act on an unauthenticated response
  offset_ = serverTimeMs - (int64_t)nowMs;  // device clock never authorises anything: only server time + signed windows do
  JsonValue root; if (!JsonParser::parse(body, root) || root.type != JsonValue::Object) return true;
  if (const JsonValue* cfg = root.get("config")) { Mode m = modeFromString(cfg->str("vendMode")); if (m != Mode::Unknown) mode_ = m; }  // authenticated config decides the vend mode
  const JsonValue* cmds = root.get("commands");
  if (!cmds || cmds->type != JsonValue::Array) return true;
  for (auto& item : cmds->arr) {
    const JsonValue* c = item.get("command"); if (!c || c->type != JsonValue::Object) continue;
    VendCommand v; v.vendId = c->str("vendId"); v.tableId = c->str("tableId"); v.deviceId = c->str("deviceId"); v.mode = c->str("mode"); v.nonce = c->str("nonce");
    v.pulses = (int)c->integer("pulses"); v.pulseMs = (int)c->integer("pulseMs"); v.gapMs = (int)c->integer("gapMs"); v.holdMs = (int)c->integer("holdMs");
    v.issuedAt = c->integer("issuedAt"); v.expiresAt = c->integer("expiresAt");
    Verify r = verifyCommand(v, item.str("signature"), secret_, id_, mode_, serverTimeMs, nonces_);
    if (r != Verify::Ok) { rejected_++; lastReject_ = verifyName(r); continue; }
    if (executed_.has(v.vendId)) { acks_.push_back({v.vendId, v.nonce, "ACK"}); continue; }  // resend of a vend we already did: re-acknowledge, NEVER vend again
    startOrQueue(v, nowMs);
  }
  return true;
}

void DeviceCore::startOrQueue(const VendCommand& c, uint32_t nowMs) {
  if (seq_.busy() || !waiting_.empty()) { for (auto& w : waiting_) if (w.vendId == c.vendId) return; waiting_.push_back(c); return; }
  executed_.add(c.vendId);  // persisted BEFORE the output moves: at-most-once release even if power dies mid-vend
  if (seq_.start(c, nowMs)) { activeVend_ = c.vendId; activeNonce_ = c.nonce; }
  else { acks_.push_back({c.vendId, c.nonce, "REJECT"}); }
}

void DeviceCore::tick(uint32_t nowMs) {
  seq_.tick(nowMs);
  bool faulted = false;
  if (seq_.takeFinished(&faulted)) { acks_.push_back({activeVend_, activeNonce_, faulted ? "REJECT" : "ACK"}); activeVend_.clear(); }
  if (!seq_.busy() && !waiting_.empty()) { VendCommand c = waiting_.front(); waiting_.erase(waiting_.begin()); startOrQueue(c, nowMs); }
}
}  // namespace pt
