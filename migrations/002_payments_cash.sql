-- Phase 2: Daraja, shared-till protection, vouchers, staff, shifts, cash POS.
ALTER TABLE pool_tables ADD COLUMN public_code TEXT;
CREATE UNIQUE INDEX pool_tables_public_code ON pool_tables(public_code);
ALTER TABLE payments ADD COLUMN attendant_id TEXT;
ALTER TABLE payments ADD COLUMN shift_id TEXT;

CREATE TABLE users (
  id TEXT PRIMARY KEY,
  username TEXT NOT NULL UNIQUE,
  display_name TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('owner','manager','attendant')),
  password_hash TEXT,
  pin_hash TEXT,
  totp_secret_enc TEXT,
  failed_attempts INTEGER NOT NULL DEFAULT 0,
  locked_until TEXT,
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0,1)),
  can_see_money INTEGER NOT NULL DEFAULT 1 CHECK (can_see_money IN (0,1)),
  void_limit_minor INTEGER NOT NULL DEFAULT 50000,
  discount_limit_minor INTEGER NOT NULL DEFAULT 2000,
  token_version INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);

-- Every M-Pesa receipt ever seen, from any channel. PRIMARY KEY = one receipt, one meaning.
CREATE TABLE mpesa_receipts (
  receipt TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('STK','C2B')),
  ref_id TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE mpesa_requests (
  id TEXT PRIMARY KEY,
  idempotency_key TEXT NOT NULL UNIQUE,
  table_id TEXT NOT NULL REFERENCES pool_tables(id),
  games INTEGER NOT NULL CHECK (games >= 1),
  amount_minor INTEGER NOT NULL CHECK (amount_minor > 0),
  phone_hash TEXT NOT NULL,
  phone_enc TEXT NOT NULL,
  attendant_id TEXT,
  status TEXT NOT NULL CHECK (status IN ('INITIATING','PENDING','TIMEOUT','SUCCESS','CANCELLED','WRONG_PIN','INSUFFICIENT_FUNDS','FAILED','EXPIRED')),
  checkout_request_id TEXT UNIQUE,
  merchant_request_id TEXT,
  result_code INTEGER,
  result_desc TEXT,
  receipt TEXT,
  payment_id TEXT,
  credited_without_receipt INTEGER NOT NULL DEFAULT 0,
  query_attempts INTEGER NOT NULL DEFAULT 0,
  next_query_at_ms INTEGER,
  created_at TEXT NOT NULL,
  expires_at_ms INTEGER NOT NULL,
  completed_at TEXT
);
CREATE INDEX mpesa_requests_status ON mpesa_requests(status, next_query_at_ms);

CREATE TABLE mpesa_callbacks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL,
  checkout_request_id TEXT,
  source_ip TEXT,
  body_json TEXT NOT NULL,
  verdict TEXT NOT NULL,
  received_at TEXT NOT NULL
);

CREATE TABLE unallocated_payments (
  id TEXT PRIMARY KEY,
  receipt TEXT NOT NULL UNIQUE,
  source TEXT NOT NULL,
  amount_minor INTEGER NOT NULL CHECK (amount_minor > 0),
  phone_hash TEXT,
  account_ref TEXT,
  reason TEXT NOT NULL,
  raw_json TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'UNALLOCATED' CHECK (status IN ('UNALLOCATED','ASSIGNED')),
  received_at TEXT NOT NULL,
  assigned_table_id TEXT,
  assigned_by TEXT,
  assign_reason TEXT,
  assigned_at TEXT,
  payment_id TEXT
);

CREATE TABLE vouchers (
  id TEXT PRIMARY KEY,
  batch_id TEXT NOT NULL,
  code_hash TEXT NOT NULL UNIQUE,
  code_tail TEXT NOT NULL,
  games INTEGER NOT NULL CHECK (games >= 1),
  table_id TEXT,
  status TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','REDEEMED','VOID')),
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  redeemed_at TEXT,
  redeemed_table_id TEXT,
  redeemed_txn_id TEXT
);

CREATE TABLE shifts (
  id TEXT PRIMARY KEY,
  attendant_id TEXT NOT NULL REFERENCES users(id),
  status TEXT NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN','CLOSED')),
  float_minor INTEGER NOT NULL CHECK (float_minor >= 0),
  opened_at TEXT NOT NULL,
  closed_at TEXT,
  counted_minor INTEGER,
  expected_minor INTEGER,
  variance_minor INTEGER,
  variance_flagged INTEGER NOT NULL DEFAULT 0
);
CREATE UNIQUE INDEX one_open_shift_per_attendant ON shifts(attendant_id) WHERE status = 'OPEN';
CREATE TRIGGER closed_shift_immutable BEFORE UPDATE ON shifts WHEN OLD.status = 'CLOSED'
BEGIN SELECT RAISE(ABORT, 'closed shifts are immutable'); END;
CREATE TRIGGER shift_no_delete BEFORE DELETE ON shifts
BEGIN SELECT RAISE(ABORT, 'shifts cannot be deleted'); END;

CREATE TABLE shift_adjustments (
  id TEXT PRIMARY KEY,
  shift_id TEXT NOT NULL REFERENCES shifts(id),
  amount_minor INTEGER NOT NULL,
  reason TEXT NOT NULL,
  approved_by TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE receipt_counters (name TEXT PRIMARY KEY, n INTEGER NOT NULL);

CREATE TABLE cash_sales (
  id TEXT PRIMARY KEY,
  receipt_no TEXT NOT NULL UNIQUE,
  receipt_seq INTEGER NOT NULL UNIQUE,
  shift_id TEXT NOT NULL REFERENCES shifts(id),
  attendant_id TEXT NOT NULL REFERENCES users(id),
  table_id TEXT NOT NULL REFERENCES pool_tables(id),
  payment_id TEXT NOT NULL,
  cash_received_minor INTEGER NOT NULL CHECK (cash_received_minor > 0),
  discount_minor INTEGER NOT NULL DEFAULT 0 CHECK (discount_minor >= 0),
  discount_reason TEXT,
  change_minor INTEGER NOT NULL DEFAULT 0 CHECK (change_minor >= 0),
  games INTEGER NOT NULL,
  offline INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','VOIDED')),
  void_reason TEXT,
  voided_by TEXT,
  void_approved_by TEXT,
  voided_at TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX cash_sales_shift ON cash_sales(shift_id);

CREATE TABLE rate_events (
  key TEXT NOT NULL,
  at_ms INTEGER NOT NULL
);
CREATE INDEX rate_events_key ON rate_events(key, at_ms);
