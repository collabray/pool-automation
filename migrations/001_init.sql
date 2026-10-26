-- Phase 1 schema. Money is INTEGER minor units (1 KES = 100). Timestamps are ISO-8601 UTC text.

CREATE TABLE pool_tables (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'pool',
  status TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','DISABLED','FAULTED')),
  fault_reason TEXT,
  online INTEGER NOT NULL DEFAULT 0 CHECK (online IN (0,1)),
  ready INTEGER NOT NULL DEFAULT 1 CHECK (ready IN (0,1)),
  requires_ready_sensor INTEGER NOT NULL DEFAULT 0 CHECK (requires_ready_sensor IN (0,1)),
  confirm_by_sensor INTEGER NOT NULL DEFAULT 0 CHECK (confirm_by_sensor IN (0,1)),
  release_mode TEXT NOT NULL DEFAULT 'ONE' CHECK (release_mode IN ('ONE','ALL')),
  vend_mode TEXT NOT NULL CHECK (vend_mode IN ('COIN_PULSE','SOLENOID_SLIDE','GATE_SOLENOID')),
  vend_params_json TEXT NOT NULL,
  pricing_json TEXT NOT NULL,
  vend_timeout_ms INTEGER NOT NULL DEFAULT 15000 CHECK (vend_timeout_ms >= 1000),
  max_vend_attempts INTEGER NOT NULL DEFAULT 3 CHECK (max_vend_attempts BETWEEN 1 AND 10),
  command_ttl_ms INTEGER NOT NULL DEFAULT 30000 CHECK (command_ttl_ms >= 1000),
  device_id TEXT UNIQUE,
  device_secret_enc TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE payments (
  id TEXT PRIMARY KEY,
  source TEXT NOT NULL CHECK (source IN ('MPESA_STK','MPESA_C2B','CASH','VOUCHER')),
  ref_namespace TEXT NOT NULL CHECK (ref_namespace IN ('MPESA','CASH','VOUCHER')),
  external_ref TEXT NOT NULL,
  idempotency_key TEXT NOT NULL UNIQUE,
  table_id TEXT NOT NULL REFERENCES pool_tables(id),
  owner_ref TEXT,
  amount_minor INTEGER NOT NULL CHECK (amount_minor > 0),
  games_credited INTEGER NOT NULL CHECK (games_credited >= 0),
  charged_minor INTEGER NOT NULL CHECK (charged_minor >= 0),
  wallet_used_minor INTEGER NOT NULL DEFAULT 0 CHECK (wallet_used_minor >= 0),
  remainder_minor INTEGER NOT NULL CHECK (remainder_minor >= 0),
  remainder_action TEXT NOT NULL CHECK (remainder_action IN ('NONE','HELD','REFUND_DUE')),
  ledger_txn_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  -- One M-Pesa receipt (or cash receipt, or voucher) can never create credits twice.
  UNIQUE (ref_namespace, external_ref)
);

CREATE TABLE ledger_entries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  txn_id TEXT NOT NULL,
  account TEXT NOT NULL,
  unit TEXT NOT NULL CHECK (unit IN ('KES','GAME')),
  amount INTEGER NOT NULL CHECK (amount <> 0),
  table_id TEXT,
  ref_type TEXT NOT NULL,
  ref_id TEXT NOT NULL,
  memo TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX ledger_account_idx ON ledger_entries(account);
CREATE INDEX ledger_txn_idx ON ledger_entries(txn_id);
CREATE TRIGGER ledger_no_update BEFORE UPDATE ON ledger_entries
BEGIN SELECT RAISE(ABORT, 'ledger is immutable'); END;
CREATE TRIGGER ledger_no_delete BEFORE DELETE ON ledger_entries
BEGIN SELECT RAISE(ABORT, 'ledger is immutable'); END;

CREATE TABLE vends (
  id TEXT PRIMARY KEY,
  table_id TEXT NOT NULL REFERENCES pool_tables(id),
  seq INTEGER NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('QUEUED','SENT','ACKED','CONFIRMED','FAILED','CANCELLED','REFUNDED')),
  attempts INTEGER NOT NULL DEFAULT 0,
  value_minor INTEGER NOT NULL DEFAULT 0 CHECK (value_minor >= 0),
  nonce TEXT,
  issued_at TEXT,
  expires_at TEXT,
  sent_at TEXT,
  acked_at TEXT,
  confirmed_at TEXT,
  failure_reason TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (table_id, seq)
);
CREATE INDEX vends_state_idx ON vends(table_id, state);

CREATE TABLE vend_commands (
  vend_id TEXT NOT NULL REFERENCES vends(id),
  nonce TEXT NOT NULL,
  issued_at_ms INTEGER NOT NULL,
  expires_at_ms INTEGER NOT NULL,
  PRIMARY KEY (vend_id, nonce)
);

CREATE TABLE vend_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  vend_id TEXT NOT NULL REFERENCES vends(id),
  from_state TEXT,
  to_state TEXT NOT NULL,
  reason TEXT,
  actor TEXT NOT NULL,
  at TEXT NOT NULL
);
CREATE TRIGGER vend_events_no_update BEFORE UPDATE ON vend_events
BEGIN SELECT RAISE(ABORT, 'vend_events is append-only'); END;
CREATE TRIGGER vend_events_no_delete BEFORE DELETE ON vend_events
BEGIN SELECT RAISE(ABORT, 'vend_events is append-only'); END;

CREATE TABLE idempotency_keys (
  scope TEXT NOT NULL,
  key TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  response_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (scope, key)
);

CREATE TABLE audit_log (
  seq INTEGER PRIMARY KEY,
  ts TEXT NOT NULL,
  actor TEXT NOT NULL,
  action TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  data_json TEXT NOT NULL,
  prev_hash TEXT NOT NULL,
  hash TEXT NOT NULL UNIQUE
);
CREATE TRIGGER audit_no_update BEFORE UPDATE ON audit_log
BEGIN SELECT RAISE(ABORT, 'audit_log is append-only'); END;
CREATE TRIGGER audit_no_delete BEFORE DELETE ON audit_log
BEGIN SELECT RAISE(ABORT, 'audit_log is append-only'); END;

CREATE TABLE alerts (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  severity TEXT NOT NULL CHECK (severity IN ('LOW','MEDIUM','HIGH')),
  table_id TEXT,
  message TEXT NOT NULL,
  created_at TEXT NOT NULL,
  resolved_at TEXT
);

CREATE TABLE settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
