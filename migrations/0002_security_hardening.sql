-- Migration 0002: Stage 1 Security & Scale Hardening (Ponytail Audit)
-- 1. Persistent D1 tables for cross-isolate PIN brute-force rate limiting and mutation idempotency.
-- 2. Role-salted SHA-256 credentials (`<ROLE>:mbg-pin-v1:<PIN>`) and removal of plaintext PINs in `app_settings`.

CREATE TABLE IF NOT EXISTS security_rate_limits (
  client_key TEXT PRIMARY KEY,
  fail_count INTEGER NOT NULL DEFAULT 0,
  reset_at_ms INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE IF NOT EXISTS mutation_idempotency_log (
  mutation_key TEXT PRIMARY KEY,
  result_json TEXT NOT NULL,
  expires_at_ms INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX IF NOT EXISTS idx_mutation_idempotency_expires ON mutation_idempotency_log(expires_at_ms);

-- Upgrade default role_credentials to salted SHA-256 (`<ROLE>:mbg-pin-v1:<PIN>`) without overwriting custom PINs
INSERT OR IGNORE INTO role_credentials (role, pin_sha256, updated_at)
VALUES ('OWNER_ADMIN', '65fbd296a1ae8adde6f7340794abb06caa642dc0623c12b8a199d70d4b6265aa', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));

UPDATE role_credentials
SET pin_sha256 = '65fbd296a1ae8adde6f7340794abb06caa642dc0623c12b8a199d70d4b6265aa',
    updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
WHERE role = 'OWNER_ADMIN'
  AND pin_sha256 = 'b3282a2f2a28757b3a18ab833de16a9c54518c0b0cf493e3f0a7cf09386f326a';

INSERT OR IGNORE INTO role_credentials (role, pin_sha256, updated_at)
VALUES ('COOPERATIVE_VIEWER', '3679bb403222966183d744b3679589c8823dd3bdb739d8a15f85d5cd8d97db6a', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));

UPDATE role_credentials
SET pin_sha256 = '3679bb403222966183d744b3679589c8823dd3bdb739d8a15f85d5cd8d97db6a',
    updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
WHERE role = 'COOPERATIVE_VIEWER'
  AND pin_sha256 = '15fc36b3e80b9d7f87f7dc90cd7a2845c5d8501c30f03379fcf14154f1680380';

-- Purge plaintext PINs from app_settings
UPDATE app_settings SET admin_pin = '', coop_pin = '' WHERE id = 'default';
