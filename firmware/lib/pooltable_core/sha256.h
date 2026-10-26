#pragma once
// Portable SHA-256 / HMAC-SHA256 / hex helpers. No platform dependencies, so the same code runs on the ESP32 and in PC tests.
#include <cstddef>
#include <cstdint>
#include <string>

namespace pt {
struct Sha256 {
  uint32_t h[8]; uint8_t buf[64]; uint64_t total; size_t fill;
  Sha256() { reset(); }
  void reset();
  void update(const uint8_t* d, size_t n);
  void final(uint8_t out[32]);
};
void sha256(const uint8_t* d, size_t n, uint8_t out[32]);
void hmacSha256(const uint8_t* key, size_t klen, const uint8_t* msg, size_t mlen, uint8_t out[32]);
std::string toHex(const uint8_t* d, size_t n);
bool fromHex(const std::string& s, uint8_t* out, size_t n);
std::string sha256Hex(const std::string& s);
std::string hmacSha256Hex(const std::string& key, const std::string& msg);
bool constTimeEqual(const uint8_t* a, const uint8_t* b, size_t n);
}  // namespace pt
