// Pool table controller: ESP32 (Arduino framework). All protocol, signature, vend-timing and coin logic lives in lib/pooltable_core
// and is unit-tested on a PC. This file only connects that logic to hardware, WiFi, HTTPS, NVS, OTA and the display.
//
// SAFETY MODEL
//  * The vend output pin is driven to its inactive level first thing in setup() and by an external pull resistor before that.
//  * Output timing runs in its own high-priority task, independent of network blocking, with an absolute max on-time guard.
//  * A vend only ever happens for a command that passed: HMAC signature, device id, mode, hard limits, expiry (server time), nonce replay.
//  * Each vend ID is recorded in NVS BEFORE the output moves => at-most-once release across power loss and server resends.
#include <Arduino.h>
#include <DNSServer.h>
#include <HTTPClient.h>
#include <Preferences.h>
#include <Update.h>
#include <WebServer.h>
#include <WiFi.h>
#include <WiFiClientSecure.h>
#include <esp_ota_ops.h>
#include <esp_system.h>
#include <esp_task_wdt.h>
#include <mbedtls/base64.h>
#include <mbedtls/gcm.h>
#include <mbedtls/pk.h>
#include <sys/time.h>
#include "config.h"
#include "coin_counter.h"
#include "device_core.h"
#include "sha256.h"
#ifdef USE_OLED
#include <U8g2lib.h>
#include <Wire.h>
#endif

using namespace pt;

extern const char server_ca_start[] asm("_binary_certs_server_ca_pem_start");
extern const char ota_pub_start[] asm("_binary_certs_ota_pub_pem_start");
extern const char ota_pub_end[] asm("_binary_certs_ota_pub_pem_end");

// ------------------------------ storage (NVS, secrets encrypted) ------------------------------
static Preferences prefs;
static uint8_t boxKey[32];

static void deriveBoxKey() {
  uint8_t salt[16]; size_t n = prefs.getBytes("salt", salt, sizeof salt);
  if (n != sizeof salt) { for (auto& b : salt) b = (uint8_t)esp_random(); prefs.putBytes("salt", salt, sizeof salt); }
  uint8_t mac[6]; esp_efuse_mac_get_default(mac);
  std::string msg((const char*)mac, 6); msg += "pt-nvs-v1";
  hmacSha256(salt, sizeof salt, (const uint8_t*)msg.data(), msg.size(), boxKey);
}
// AES-256-GCM: iv(12) | tag(16) | ciphertext. Protects against casual flash reads; see docs/SECURITY.md about enabling ESP32 flash encryption for real tamper resistance.
static bool boxSeal(const std::string& plain, std::string& out) {
  uint8_t iv[12]; for (auto& b : iv) b = (uint8_t)esp_random();
  std::string ct(plain.size(), 0); uint8_t tag[16];
  mbedtls_gcm_context g; mbedtls_gcm_init(&g); bool ok = mbedtls_gcm_setkey(&g, MBEDTLS_CIPHER_ID_AES, boxKey, 256) == 0 &&
    mbedtls_gcm_crypt_and_tag(&g, MBEDTLS_GCM_ENCRYPT, plain.size(), iv, 12, nullptr, 0, (const uint8_t*)plain.data(), (uint8_t*)&ct[0], 16, tag) == 0;
  mbedtls_gcm_free(&g); if (!ok) return false;
  out.assign((const char*)iv, 12); out.append((const char*)tag, 16); out += ct; return true;
}
static bool boxOpen(const std::string& blob, std::string& plain) {
  if (blob.size() < 28) return false;
  plain.assign(blob.size() - 28, 0);
  mbedtls_gcm_context g; mbedtls_gcm_init(&g);
  bool ok = mbedtls_gcm_setkey(&g, MBEDTLS_CIPHER_ID_AES, boxKey, 256) == 0 &&
    mbedtls_gcm_auth_decrypt(&g, plain.size(), (const uint8_t*)blob.data(), 12, nullptr, 0, (const uint8_t*)blob.data() + 12, 16, (const uint8_t*)blob.data() + 28, (uint8_t*)&plain[0]) == 0;
  mbedtls_gcm_free(&g); return ok;
}
static void putSecret(const char* key, const std::string& v) { std::string b; if (boxSeal(v, b)) prefs.putBytes(key, b.data(), b.size()); }
static std::string getSecret(const char* key) {
  size_t n = prefs.getBytesLength(key); if (!n || n > 512) return "";
  std::string b(n, 0); prefs.getBytes(key, &b[0], n); std::string p; return boxOpen(b, p) ? p : "";
}
struct NvsStore : PersistentSet::Store {
  const char* key; explicit NvsStore(const char* k) : key(k) {}
  std::string load() override { return std::string(prefs.getString(key, "").c_str()); }
  void save(const std::string& blob) override { prefs.putString(key, blob.c_str()); }
};

// ------------------------------ output driver ------------------------------
struct PinOutput : IOutput { void set(bool on) override { digitalWrite(PIN_VEND_OUT, (on == VEND_ACTIVE_HIGH) ? HIGH : LOW); } };

// ------------------------------ globals ------------------------------
static PinOutput outPin; static VendSequencer* seq; static NvsStore nonceStore("nonces"), vendStore("vends");
static PersistentSet* nonceSet; static PersistentSet* vendSet; static DeviceCore* core; static SemaphoreHandle_t coreMutex;
static std::string cfgSsid, cfgPass, cfgServer, cfgDevId, cfgSecret;
static volatile bool serverOk = false, wifiOk = false, readyState = true, tamperState = false, manualEnabled = false, portalMode = false;
static volatile int lastRssi = 0; static volatile uint32_t lastSyncOkMs = 0;
static String bootId; static uint32_t coinSeq = 0; static std::string resetReason;
static CoinCounter coins(COIN_DEBOUNCE_US, COIN_MIN_PULSE_US, COIN_MAX_PULSE_US, COIN_PULSES_PER_COIN);
static Debouncer readyDeb(80, false), tamperDeb(80, false);
struct Edge { uint32_t t; bool level; };
static volatile Edge edgeRing[64]; static volatile uint8_t edgeHead = 0, edgeTail = 0;

static void IRAM_ATTR coinIsr() {
  uint8_t next = (edgeHead + 1) & 63; if (next == edgeTail) return;
  edgeRing[edgeHead].t = (uint32_t)micros(); edgeRing[edgeHead].level = (digitalRead(PIN_COIN_IN) == (COIN_ACTIVE_LOW ? LOW : HIGH)); edgeHead = next;
}
static std::string resetReasonName() {
  switch (esp_reset_reason()) { case ESP_RST_POWERON: return "poweron"; case ESP_RST_BROWNOUT: return "brownout"; case ESP_RST_PANIC: return "panic"; case ESP_RST_INT_WDT: return "int_wdt";
    case ESP_RST_TASK_WDT: return "task_wdt"; case ESP_RST_WDT: return "wdt"; case ESP_RST_SW: return "sw"; case ESP_RST_DEEPSLEEP: return "deepsleep"; default: return "other"; }
}
static int64_t epochMs() { struct timeval tv; gettimeofday(&tv, nullptr); return (int64_t)tv.tv_sec * 1000 + tv.tv_usec / 1000; }
static std::string randHex(size_t bytes) { std::string s; for (size_t i = 0; i < bytes; i++) { uint8_t b = (uint8_t)esp_random(); s += toHex(&b, 1); } return s; }
static Mode currentMode = Mode::GateSolenoid;

// ------------------------------ provisioning portal (captive) ------------------------------
static const char PORTAL_HTML[] PROGMEM =
  "<!doctype html><meta name=viewport content='width=device-width,initial-scale=1'><title>Table setup</title><style>body{font-family:sans-serif;max-width:28rem;margin:1rem auto;padding:0 1rem}"
  "input{width:100%;padding:.6rem;margin:.2rem 0 .8rem;box-sizing:border-box}button{padding:.8rem 1.2rem}</style><h2>Pool table setup</h2><form method=post action=/save>"
  "WiFi name<input name=ssid required maxlength=32>WiFi password<input name=pass type=password maxlength=63>Server address (https://...)<input name=server required placeholder='https://pool.example.com'>"
  "Device ID<input name=id required pattern='dev_[0-9a-f]{12}'>Device secret<input name=secret required pattern='[0-9a-f]{64}'><button>Save and restart</button></form>";
static void runPortal() {
  portalMode = true; std::string apPass = randHex(4); String ssid = "PoolTable-" + String((uint32_t)(ESP.getEfuseMac() >> 24), HEX);
  WiFi.mode(WIFI_AP); WiFi.softAP(ssid.c_str(), apPass.c_str());
  Serial.printf("\n=== SETUP MODE ===\nJoin WiFi '%s' with password '%s', then open http://192.168.4.1\n", ssid.c_str(), apPass.c_str());
  DNSServer dns; dns.start(53, "*", WiFi.softAPIP()); WebServer web(80);
  auto ok = [](const String& s, const char* re) { for (size_t i = 0; i < s.length(); i++) if ((uint8_t)s[i] < 32) return false; (void)re; return true; };
  web.onNotFound([&]() { web.send(200, "text/html", PORTAL_HTML); });
  web.on("/save", HTTP_POST, [&]() {
    String ssidIn = web.arg("ssid"), pw = web.arg("pass"), srv = web.arg("server"), id = web.arg("id"), sec = web.arg("secret");
    bool good = ssidIn.length() && ssidIn.length() <= 32 && pw.length() <= 63 && srv.startsWith("https://") && srv.length() < 120 && ok(ssidIn, "") && ok(srv, "") && id.length() == 16 && id.startsWith("dev_") && sec.length() == 64;
    uint8_t tmp[32]; good = good && fromHex(std::string(sec.c_str()), tmp, 32);
    if (!good) { web.send(400, "text/plain", "Invalid values. Check the device ID and secret shown in the admin dashboard."); return; }
    while (srv.endsWith("/")) srv.remove(srv.length() - 1);
    putSecret("ssid_e", ssidIn.c_str()); putSecret("pass_e", pw.c_str()); putSecret("secret_e", sec.c_str()); prefs.putString("server", srv); prefs.putString("devid", id);
    web.send(200, "text/plain", "Saved. The controller is restarting."); delay(800); ESP.restart();
  });
  uint32_t t0 = millis();
  for (;;) { dns.processNextRequest(); web.handleClient(); digitalWrite(PIN_LED, (millis() / 100) & 1); esp_task_wdt_reset(); delay(2); if (millis() - t0 > 30UL * 60 * 1000) ESP.restart(); }
}

// ------------------------------ HTTPS ------------------------------
struct HttpResult { int status = -1; std::string body, respSig, nonce; int64_t serverTime = 0; };
static HttpResult signedRequest(const char* method, const std::string& path, const std::string& body, int timeoutMs) {
  HttpResult r; WiFiClientSecure tls; tls.setCACert(server_ca_start); tls.setTimeout(timeoutMs / 1000 + 1);
  HTTPClient http; http.setConnectTimeout(timeoutMs); http.setTimeout(timeoutMs); http.setReuse(false);
  if (!http.begin(tls, (cfgServer + path).c_str())) return r;
  int64_t ts = epochMs(); r.nonce = randHex(16);
  http.addHeader("Content-Type", "application/json"); http.addHeader("X-Device-Id", cfgDevId.c_str()); http.addHeader("X-Ts", String((long long)ts)); http.addHeader("X-Nonce", r.nonce.c_str());
  http.addHeader("X-Sig", signRequest(cfgSecret, method, path, ts, r.nonce, body).c_str());
  const char* want[] = {"X-Resp-Sig", "X-Server-Time"}; http.collectHeaders(want, 2);
  r.status = strcmp(method, "POST") == 0 ? http.POST((uint8_t*)body.data(), body.size()) : http.GET();
  if (r.status > 0) { r.body = std::string(http.getString().c_str()); r.respSig = std::string(http.header("X-Resp-Sig").c_str()); r.serverTime = atoll(http.header("X-Server-Time").c_str()); }
  http.end(); return r;
}

// ------------------------------ OTA with signature verification + rollback ------------------------------
static bool verifyImageSignature(const uint8_t digest[32], const std::string& sigB64) {
  uint8_t sig[96]; size_t sl = 0; if (mbedtls_base64_decode(sig, sizeof sig, &sl, (const uint8_t*)sigB64.data(), sigB64.size()) != 0) return false;
  mbedtls_pk_context pk; mbedtls_pk_init(&pk);
  bool ok = mbedtls_pk_parse_public_key(&pk, (const uint8_t*)ota_pub_start, (size_t)(ota_pub_end - ota_pub_start)) == 0 && mbedtls_pk_verify(&pk, MBEDTLS_MD_SHA256, digest, 32, sig, sl) == 0;
  mbedtls_pk_free(&pk); return ok;
}
static void tryOta(const std::string& version, const std::string& shaHex, const std::string& sigB64, size_t size) {
  if (size < 100000 || size > 1900000 || seq->busy()) return;
  WiFiClientSecure tls; tls.setCACert(server_ca_start); HTTPClient http; http.setTimeout(20000);
  std::string path = "/api/device/ota/" + version; int64_t ts = epochMs(); std::string nonce = randHex(16);
  if (!http.begin(tls, (cfgServer + path).c_str())) return;
  http.addHeader("X-Device-Id", cfgDevId.c_str()); http.addHeader("X-Ts", String((long long)ts)); http.addHeader("X-Nonce", nonce.c_str()); http.addHeader("X-Sig", signRequest(cfgSecret, "GET", path, ts, nonce, "").c_str());
  if (http.GET() != 200 || (size_t)http.getSize() != size || !Update.begin(size)) { http.end(); return; }
  Sha256 h; uint8_t buf[1024]; size_t got = 0; WiFiClient* s = http.getStreamPtr(); uint32_t last = millis();
  while (got < size && millis() - last < 15000) { int n = s->readBytes(buf, min((size_t)sizeof buf, size - got)); if (n > 0) { h.update(buf, n); if (Update.write(buf, n) != (size_t)n) break; got += n; last = millis(); } esp_task_wdt_reset(); }
  http.end(); uint8_t digest[32]; h.final(digest);
  if (got != size || toHex(digest, 32) != shaHex || !verifyImageSignature(digest, sigB64)) { Update.abort(); Serial.println("OTA rejected (size/hash/signature)"); return; }  // nothing is activated unless the signature verifies
  if (Update.end(true)) { Serial.println("OTA verified, rebooting"); delay(300); ESP.restart(); }
}
static bool pendingVerify() { const esp_partition_t* p = esp_ota_get_running_partition(); esp_ota_img_states_t st; return esp_ota_get_state_partition(p, &st) == ESP_OK && st == ESP_OTA_IMG_PENDING_VERIFY; }

// ------------------------------ tasks ------------------------------
static void outputTask(void*) {
  esp_task_wdt_add(nullptr);
  for (;;) {
    while (edgeTail != edgeHead) { Edge e = {edgeRing[edgeTail].t, edgeRing[edgeTail].level}; edgeTail = (edgeTail + 1) & 63; coins.onEdge(e.level, e.t); }
    uint32_t c = coins.takeCoins();
    xSemaphoreTake(coreMutex, portMAX_DELAY);
    if (c) core->queueCoinEvent(std::string("c") + bootId.c_str() + "-" + std::to_string(++coinSeq), (int)c);
    core->tick(millis());
    xSemaphoreGive(coreMutex); esp_task_wdt_reset(); vTaskDelay(1);
  }
}
static void netTask(void*) {
  esp_task_wdt_add(nullptr); uint32_t backoff = 1000; uint32_t lastOtaCheck = 0; bool ntpStarted = false;
  for (;;) {
    esp_task_wdt_reset();
    if (WiFi.status() != WL_CONNECTED) {
      wifiOk = false; serverOk = false; WiFi.mode(WIFI_STA); WiFi.begin(cfgSsid.c_str(), cfgPass.c_str());
      uint32_t t0 = millis(); while (WiFi.status() != WL_CONNECTED && millis() - t0 < 15000) { vTaskDelay(200); esp_task_wdt_reset(); }
      if (WiFi.status() != WL_CONNECTED) { vTaskDelay(backoff); backoff = min<uint32_t>(backoff * 2, 60000); continue; }
    }
    wifiOk = true; lastRssi = WiFi.RSSI();
    if (!ntpStarted) { configTime(0, 0, "pool.ntp.org", "time.google.com"); ntpStarted = true; }  // needed for TLS certificate validity + request timestamps only
    if (time(nullptr) < 1700000000) { vTaskDelay(500); continue; }
    Telemetry t; t.fw = FW_VERSION; t.uptimeS = millis() / 1000; t.rssi = lastRssi; t.freeHeap = ESP.getFreeHeap(); t.resetReason = resetReason; t.ready = readyState; t.tamper = tamperState;
    std::vector<PendingAck> sa; std::vector<PendingEvent> se;
    xSemaphoreTake(coreMutex, portMAX_DELAY); bool busy = core->hasPendingWork(); std::string body = core->buildSync(t, busy ? 0 : SYNC_WAIT_SEC, millis(), &sa, &se); xSemaphoreGive(coreMutex);
    HttpResult r = signedRequest("POST", "/api/device/sync", body, HTTP_TIMEOUT_MS + SYNC_WAIT_SEC * 1000);
    bool good = false;
    if (r.status == 200) {
      xSemaphoreTake(coreMutex, portMAX_DELAY); good = core->handleResponse(r.body, r.respSig, r.nonce, r.serverTime, millis()); xSemaphoreGive(coreMutex);
      if (good) {
        JsonValue j; if (JsonParser::parse(r.body, j)) { if (auto* cfg = j.get("config")) { manualEnabled = cfg->boolean("manualVendEnabled"); { Mode m = modeFromString(cfg->str("vendMode")); if (m != Mode::Unknown && (uint8_t)m != prefs.getUChar("mode", 255)) prefs.putUChar("mode", (uint8_t)m); }
          if (auto* o = cfg->get("ota")) { std::string v = o->str("version"); if (!v.empty() && v != FW_VERSION && millis() - lastOtaCheck > 60000) { lastOtaCheck = millis(); tryOta(v, o->str("sha256"), o->str("signature"), (size_t)o->integer("size")); } } } }
        if (pendingVerify()) esp_ota_mark_app_valid_cancel_rollback();  // the new firmware proved it can authenticate to the server
        lastSyncOkMs = millis();
      }
    }
    if (!good) { xSemaphoreTake(coreMutex, portMAX_DELAY); core->restoreAcks(sa, se); xSemaphoreGive(coreMutex); }
    serverOk = good; if (good) backoff = 1000; else { vTaskDelay(backoff); backoff = min<uint32_t>(backoff * 2, 60000); }
    if (pendingVerify() && millis() > 180000 && lastSyncOkMs == 0) esp_ota_mark_app_invalid_rollback_and_reboot();  // new image never reached the server: roll back
  }
}

// ------------------------------ status LED / OLED ------------------------------
#ifdef USE_OLED
static U8G2_SSD1306_128X64_NONAME_F_HW_I2C oled(U8G2_R0, U8X8_PIN_NONE, PIN_I2C_SCL, PIN_I2C_SDA);
#endif
static void statusLoop(uint32_t now) {
  bool led;
  if (!wifiOk) led = (now / 1000) & 1;                                  // slow blink: no WiFi
  else if (!serverOk) led = ((now % 1200) < 100) || ((now % 1200) > 250 && (now % 1200) < 350);  // double blink: WiFi ok, server unreachable
  else if (tamperState) led = (now / 120) & 1;                          // fast blink: tamper
  else led = (now % 3000) < 80;                                         // brief flash: healthy
  digitalWrite(PIN_LED, led);
#ifdef USE_OLED
  static uint32_t lastDraw = 0; if (now - lastDraw > 1000) { lastDraw = now;
    oled.clearBuffer(); oled.setFont(u8g2_font_6x10_tf); oled.drawStr(0, 10, wifiOk ? "WiFi OK" : "WiFi --"); oled.drawStr(0, 22, serverOk ? "Server OK" : "Server --");
    char b[32]; snprintf(b, sizeof b, "RSSI %d  fw %s", (int)lastRssi, FW_VERSION); oled.drawStr(0, 34, b); oled.drawStr(0, 46, readyState ? "Table ready" : "Game in progress"); oled.drawStr(0, 58, tamperState ? "TAMPER" : "Secure"); oled.sendBuffer(); }
#endif
}

void setup() {
  pinMode(PIN_VEND_OUT, OUTPUT); outPin.set(false);       // FIRST: output inactive
  pinMode(PIN_LED, OUTPUT); pinMode(PIN_BUTTON, INPUT_PULLUP); pinMode(PIN_COIN_IN, INPUT_PULLUP); pinMode(PIN_READY_IN, INPUT_PULLUP); pinMode(PIN_TAMPER_IN, INPUT_PULLUP);
  Serial.begin(115200); resetReason = resetReasonName(); Serial.printf("\nPoolTable fw %s, reset reason: %s\n", FW_VERSION, resetReason.c_str());
  esp_task_wdt_init(WDT_TIMEOUT_SEC, true);
  prefs.begin("pt", false); deriveBoxKey();
  uint32_t held = millis(); while (digitalRead(PIN_BUTTON) == LOW && millis() - held < BUTTON_RESET_HOLD_MS) delay(20);
  if (digitalRead(PIN_BUTTON) == LOW) { prefs.clear(); Serial.println("Factory reset: credentials erased"); for (int i = 0; i < 6; i++) { digitalWrite(PIN_LED, i & 1); delay(150); } ESP.restart(); }
  cfgSsid = getSecret("ssid_e"); cfgPass = getSecret("pass_e"); cfgSecret = getSecret("secret_e"); cfgServer = std::string(prefs.getString("server", "").c_str()); cfgDevId = std::string(prefs.getString("devid", "").c_str());
  if (cfgSsid.empty() || cfgSecret.size() != 64 || cfgServer.empty() || cfgDevId.empty()) runPortal();  // never returns
  currentMode = (Mode)prefs.getUChar("mode", (uint8_t)Mode::GateSolenoid);  // last known mode; replaced by the server's authenticated config on every sync
  bootId = String((uint32_t)esp_random(), HEX);
  seq = new VendSequencer(outPin); nonceSet = new PersistentSet(NONCE_MEMORY, &nonceStore); vendSet = new PersistentSet(VEND_MEMORY, &vendStore);
  core = new DeviceCore(cfgDevId, cfgSecret, currentMode, *seq, *nonceSet, *vendSet); coreMutex = xSemaphoreCreateMutex();
  attachInterrupt(digitalPinToInterrupt(PIN_COIN_IN), coinIsr, CHANGE);
#ifdef USE_OLED
  Wire.begin(PIN_I2C_SDA, PIN_I2C_SCL); oled.begin();
#endif
  xTaskCreatePinnedToCore(outputTask, "vend", 4096, nullptr, 5, nullptr, 1);
  xTaskCreatePinnedToCore(netTask, "net", 14336, nullptr, 1, nullptr, 0);
}

void loop() {
  uint32_t now = millis();
  bool r = (digitalRead(PIN_READY_IN) == (READY_ACTIVE_LOW ? LOW : HIGH)), t = (digitalRead(PIN_TAMPER_IN) == (TAMPER_ACTIVE_LOW ? LOW : HIGH));
  if (readyDeb.update(r, now)) readyState = readyDeb.state();
  if (tamperDeb.update(t, now)) { tamperState = tamperDeb.state(); xSemaphoreTake(coreMutex, portMAX_DELAY); core->queueEvent(std::string("t") + bootId.c_str() + "-" + std::to_string(now), tamperState ? "tamper" : "tamper_clear"); xSemaphoreGive(coreMutex); }
  static uint32_t pressedAt = 0; static bool wasDown = false; bool down = digitalRead(PIN_BUTTON) == LOW;
  if (down && !wasDown) pressedAt = now;
  if (!down && wasDown) {
    uint32_t held = now - pressedAt;
    if (held > 50 && held < 1500 && manualEnabled) { xSemaphoreTake(coreMutex, portMAX_DELAY); core->queueEvent(std::string("b") + bootId.c_str() + "-" + std::to_string(now), "manual_request"); xSemaphoreGive(coreMutex); }  // a REQUEST: the server decides, limits and logs it
  }
  if (down && now - pressedAt > BUTTON_RESET_HOLD_MS) { prefs.clear(); ESP.restart(); }
  wasDown = down;
  statusLoop(now); delay(5);
}
