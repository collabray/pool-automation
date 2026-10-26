#include "sha256.h"
#include <cstring>

namespace pt {
static const uint32_t K[64] = {
  0x428a2f98,0x71374491,0xb5c0fbcf,0xe9b5dba5,0x3956c25b,0x59f111f1,0x923f82a4,0xab1c5ed5,0xd807aa98,0x12835b01,0x243185be,0x550c7dc3,0x72be5d74,0x80deb1fe,0x9bdc06a7,0xc19bf174,
  0xe49b69c1,0xefbe4786,0x0fc19dc6,0x240ca1cc,0x2de92c6f,0x4a7484aa,0x5cb0a9dc,0x76f988da,0x983e5152,0xa831c66d,0xb00327c8,0xbf597fc7,0xc6e00bf3,0xd5a79147,0x06ca6351,0x14292967,
  0x27b70a85,0x2e1b2138,0x4d2c6dfc,0x53380d13,0x650a7354,0x766a0abb,0x81c2c92e,0x92722c85,0xa2bfe8a1,0xa81a664b,0xc24b8b70,0xc76c51a3,0xd192e819,0xd6990624,0xf40e3585,0x106aa070,
  0x19a4c116,0x1e376c08,0x2748774c,0x34b0bcb5,0x391c0cb3,0x4ed8aa4a,0x5b9cca4f,0x682e6ff3,0x748f82ee,0x78a5636f,0x84c87814,0x8cc70208,0x90befffa,0xa4506ceb,0xbef9a3f7,0xc67178f2};
static inline uint32_t rotr(uint32_t x, int n) { return (x >> n) | (x << (32 - n)); }

void Sha256::reset() {
  static const uint32_t init[8] = {0x6a09e667,0xbb67ae85,0x3c6ef372,0xa54ff53a,0x510e527f,0x9b05688c,0x1f83d9ab,0x5be0cd19};
  memcpy(h, init, sizeof h); total = 0; fill = 0;
}
static void block(uint32_t h[8], const uint8_t* p) {
  uint32_t w[64];
  for (int i = 0; i < 16; i++) w[i] = (uint32_t)p[4*i] << 24 | (uint32_t)p[4*i+1] << 16 | (uint32_t)p[4*i+2] << 8 | p[4*i+3];
  for (int i = 16; i < 64; i++) {
    uint32_t s0 = rotr(w[i-15], 7) ^ rotr(w[i-15], 18) ^ (w[i-15] >> 3), s1 = rotr(w[i-2], 17) ^ rotr(w[i-2], 19) ^ (w[i-2] >> 10);
    w[i] = w[i-16] + s0 + w[i-7] + s1;
  }
  uint32_t a=h[0],b=h[1],c=h[2],d=h[3],e=h[4],f=h[5],g=h[6],hh=h[7];
  for (int i = 0; i < 64; i++) {
    uint32_t S1 = rotr(e,6) ^ rotr(e,11) ^ rotr(e,25), ch = (e & f) ^ (~e & g), t1 = hh + S1 + ch + K[i] + w[i];
    uint32_t S0 = rotr(a,2) ^ rotr(a,13) ^ rotr(a,22), mj = (a & b) ^ (a & c) ^ (b & c), t2 = S0 + mj;
    hh = g; g = f; f = e; e = d + t1; d = c; c = b; b = a; a = t1 + t2;
  }
  h[0]+=a; h[1]+=b; h[2]+=c; h[3]+=d; h[4]+=e; h[5]+=f; h[6]+=g; h[7]+=hh;
}
void Sha256::update(const uint8_t* d, size_t n) {
  total += n;
  while (n) {
    size_t take = 64 - fill; if (take > n) take = n;
    memcpy(buf + fill, d, take); fill += take; d += take; n -= take;
    if (fill == 64) { block(h, buf); fill = 0; }
  }
}
void Sha256::final(uint8_t out[32]) {
  uint64_t bits = total * 8; uint8_t pad = 0x80;
  update(&pad, 1); uint8_t z = 0; while (fill != 56) update(&z, 1);
  uint8_t len[8]; for (int i = 0; i < 8; i++) len[i] = (uint8_t)(bits >> (56 - 8 * i));
  update(len, 8);
  for (int i = 0; i < 8; i++) { out[4*i] = h[i] >> 24; out[4*i+1] = h[i] >> 16; out[4*i+2] = h[i] >> 8; out[4*i+3] = h[i]; }
}
void sha256(const uint8_t* d, size_t n, uint8_t out[32]) { Sha256 s; s.update(d, n); s.final(out); }

void hmacSha256(const uint8_t* key, size_t klen, const uint8_t* msg, size_t mlen, uint8_t out[32]) {
  uint8_t k[64] = {0};
  if (klen > 64) sha256(key, klen, k); else memcpy(k, key, klen);
  uint8_t ipad[64], opad[64];
  for (int i = 0; i < 64; i++) { ipad[i] = k[i] ^ 0x36; opad[i] = k[i] ^ 0x5c; }
  uint8_t inner[32]; Sha256 s; s.update(ipad, 64); s.update(msg, mlen); s.final(inner);
  Sha256 o; o.update(opad, 64); o.update(inner, 32); o.final(out);
}
std::string toHex(const uint8_t* d, size_t n) {
  static const char* x = "0123456789abcdef"; std::string r; r.reserve(n * 2);
  for (size_t i = 0; i < n; i++) { r += x[d[i] >> 4]; r += x[d[i] & 15]; }
  return r;
}
static int nib(char c) { return c >= '0' && c <= '9' ? c - '0' : c >= 'a' && c <= 'f' ? c - 'a' + 10 : c >= 'A' && c <= 'F' ? c - 'A' + 10 : -1; }
bool fromHex(const std::string& s, uint8_t* out, size_t n) {
  if (s.size() != n * 2) return false;
  for (size_t i = 0; i < n; i++) { int a = nib(s[2*i]), b = nib(s[2*i+1]); if (a < 0 || b < 0) return false; out[i] = (uint8_t)(a << 4 | b); }
  return true;
}
std::string sha256Hex(const std::string& s) { uint8_t o[32]; sha256((const uint8_t*)s.data(), s.size(), o); return toHex(o, 32); }
std::string hmacSha256Hex(const std::string& key, const std::string& msg) {
  uint8_t o[32]; hmacSha256((const uint8_t*)key.data(), key.size(), (const uint8_t*)msg.data(), msg.size(), o); return toHex(o, 32);
}
bool constTimeEqual(const uint8_t* a, const uint8_t* b, size_t n) { uint8_t d = 0; for (size_t i = 0; i < n; i++) d |= a[i] ^ b[i]; return d == 0; }
}  // namespace pt
