-- Signed firmware releases for over-the-air updates. The device verifies the ECDSA signature itself; the server only distributes.
CREATE TABLE firmware_releases (
  version TEXT PRIMARY KEY,
  sha256 TEXT NOT NULL,
  signature TEXT NOT NULL,
  size INTEGER NOT NULL CHECK (size BETWEEN 100000 AND 1900000),
  data BLOB NOT NULL,
  active INTEGER NOT NULL DEFAULT 0 CHECK (active IN (0,1)),
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE UNIQUE INDEX one_active_firmware ON firmware_releases(active) WHERE active = 1;

-- Manager approvals: single-use, short-lived proof that a manager/owner entered their credentials for ONE specific action.
CREATE TABLE approval_tokens (
  token_hash TEXT PRIMARY KEY,
  approver_id TEXT NOT NULL REFERENCES users(id),
  requested_by TEXT NOT NULL REFERENCES users(id),
  expires_at_ms INTEGER NOT NULL,
  used_at TEXT,
  created_at TEXT NOT NULL
);
