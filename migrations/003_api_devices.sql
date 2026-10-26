-- Phase 3: sessions, device telemetry/protocol, coin monitoring, notifications.
ALTER TABLE vend_commands ADD COLUMN command_json TEXT;
ALTER TABLE vend_commands ADD COLUMN signature TEXT;
ALTER TABLE alerts ADD COLUMN notified_at TEXT;

ALTER TABLE pool_tables ADD COLUMN last_seen_at TEXT;
ALTER TABLE pool_tables ADD COLUMN fw_version TEXT;
ALTER TABLE pool_tables ADD COLUMN rssi INTEGER;
ALTER TABLE pool_tables ADD COLUMN free_heap INTEGER;
ALTER TABLE pool_tables ADD COLUMN uptime_s INTEGER;
ALTER TABLE pool_tables ADD COLUMN last_reset_reason TEXT;
ALTER TABLE pool_tables ADD COLUMN sensors_json TEXT;
ALTER TABLE pool_tables ADD COLUMN tamper INTEGER NOT NULL DEFAULT 0;
ALTER TABLE pool_tables ADD COLUMN coin_value_minor INTEGER NOT NULL DEFAULT 2000;
ALTER TABLE pool_tables ADD COLUMN manual_vend_enabled INTEGER NOT NULL DEFAULT 0;

CREATE TABLE refresh_tokens (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  family_id TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  expires_at_ms INTEGER NOT NULL,
  used_at TEXT,
  revoked INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);
CREATE INDEX refresh_family ON refresh_tokens(family_id);

CREATE TABLE device_nonces (
  device_id TEXT NOT NULL,
  nonce TEXT NOT NULL,
  expires_ms INTEGER NOT NULL,
  PRIMARY KEY (device_id, nonce)
);

CREATE TABLE device_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  device_id TEXT NOT NULL,
  event_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  data_json TEXT NOT NULL,
  at TEXT NOT NULL,
  UNIQUE (device_id, event_id)
);

CREATE TABLE coin_events (
  id TEXT PRIMARY KEY,
  table_id TEXT NOT NULL REFERENCES pool_tables(id),
  device_event_id TEXT NOT NULL,
  coins INTEGER NOT NULL CHECK (coins >= 1),
  value_minor INTEGER NOT NULL,
  at TEXT NOT NULL,
  collection_id TEXT,
  UNIQUE (table_id, device_event_id)
);

CREATE TABLE coin_collections (
  id TEXT PRIMARY KEY,
  table_id TEXT NOT NULL REFERENCES pool_tables(id),
  collected_by TEXT NOT NULL REFERENCES users(id),
  collected_at TEXT NOT NULL,
  expected_coins INTEGER NOT NULL,
  expected_minor INTEGER NOT NULL,
  counted_minor INTEGER NOT NULL,
  variance_minor INTEGER NOT NULL,
  flagged INTEGER NOT NULL DEFAULT 0,
  note TEXT
);

CREATE TABLE manual_vends (
  id TEXT PRIMARY KEY,
  table_id TEXT NOT NULL REFERENCES pool_tables(id),
  actor_id TEXT NOT NULL REFERENCES users(id),
  shift_id TEXT,
  reason TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE error_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at TEXT NOT NULL,
  request_id TEXT,
  message TEXT NOT NULL
);
