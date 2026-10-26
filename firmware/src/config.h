#pragma once
// Pin map and tunables. Defaults suit an ESP32 DevKit + opto/relay board. Change here, rebuild, re-flash.
#include <Arduino.h>

#ifndef FW_VERSION
#define FW_VERSION "dev"
#endif

// ---- outputs (the ONLY pin that can release balls) ----
constexpr int PIN_VEND_OUT = 26;          // to optocoupler LED / relay module input / MOSFET gate via transistor
constexpr bool VEND_ACTIVE_HIGH = true;   // set false for active-low relay boards. A 10k pull-DOWN (or pull-up if active-low) to the inactive level is REQUIRED so the pin is safe while the ESP32 boots or crashes.
// ---- inputs ----
constexpr int PIN_COIN_IN = 27;           // coin acceptor pulse output (through an optocoupler/level shifter, never direct from 12 V)
constexpr bool COIN_ACTIVE_LOW = true;
constexpr int PIN_READY_IN = 25;          // balls-captured / table-ready microswitch or hall sensor (closed = ready)
constexpr bool READY_ACTIVE_LOW = true;
constexpr int PIN_TAMPER_IN = 33;         // coin-box door / tamper switch (opened = tamper)
constexpr bool TAMPER_ACTIVE_LOW = true;
constexpr int PIN_BUTTON = 14;            // hold 5 s at power-up or in run mode: factory-reset WiFi + credentials. Short press = test vend (only if enabled by the admin)
constexpr int PIN_LED = 2;
constexpr int PIN_I2C_SDA = 21, PIN_I2C_SCL = 22;   // optional OLED (build env esp32dev_oled)

// ---- coin acceptor timing (microseconds) ----
constexpr uint32_t COIN_DEBOUNCE_US = 3000, COIN_MIN_PULSE_US = 15000, COIN_MAX_PULSE_US = 150000;
constexpr uint8_t COIN_PULSES_PER_COIN = 1;

// ---- timing ----
constexpr int SYNC_WAIT_SEC = 5;           // long-poll length (server allows up to 25). Kept short so the hardware watchdog is fed often.
constexpr int HTTP_TIMEOUT_MS = 9000;
constexpr int WDT_TIMEOUT_SEC = 15;
constexpr uint32_t BUTTON_RESET_HOLD_MS = 5000;
constexpr size_t NONCE_MEMORY = 64, VEND_MEMORY = 64;  // remembered nonces / executed vend IDs (survive reboot in NVS)
