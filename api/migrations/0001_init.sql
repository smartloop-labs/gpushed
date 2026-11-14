-- Money is stored in micro-dollars (1 USD = 1,000,000) so per-minute usage
-- charges don't round away. Times are Unix seconds.

-- A gpushed user is a smartloop account: id is the smartloop user id, and
-- email is copied from smartloop at each sign-in.
CREATE TABLE users (
  id                 TEXT PRIMARY KEY,
  email              TEXT NOT NULL,
  balance_micros     INTEGER NOT NULL DEFAULT 0,
  low_balance_warned INTEGER NOT NULL DEFAULT 0,
  exhausted_at       INTEGER,          -- when the balance was first seen at or below zero
  created_at         INTEGER NOT NULL
);

-- API tokens held by the CLI; only their SHA-256 is stored.
CREATE TABLE api_tokens (
  token_hash TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL REFERENCES users(id),
  created_at INTEGER NOT NULL
);

-- status: pending | running | stopping | stopped | starting | destroying | destroyed | failed
-- metered_until: usage has been charged up to this time; NULL while no VM exists.
CREATE TABLE boxes (
  id                    TEXT PRIMARY KEY,
  user_id               TEXT NOT NULL REFERENCES users(id),
  plan                  TEXT NOT NULL,
  status                TEXT NOT NULL,
  region                TEXT NOT NULL,   -- where it runs; until placed, the first region to try
  regions               TEXT NOT NULL,   -- comma-separated regions to try for a new box, nearest first
  zone                  TEXT,
  ip                    TEXT,
  ssh_public_key        TEXT NOT NULL,
  hourly_micros         INTEGER NOT NULL,
  stopped_hourly_micros INTEGER NOT NULL,
  metered_until         INTEGER,
  stopped_at            INTEGER,
  error                 TEXT,
  created_at            INTEGER NOT NULL,
  updated_at            INTEGER NOT NULL
);
CREATE INDEX boxes_user ON boxes(user_id, status);
CREATE INDEX boxes_status ON boxes(status);

-- Every balance change. ref is unique, which makes Stripe webhooks and
-- metering runs idempotent: a repeated ref aborts the whole batch.
CREATE TABLE ledger (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id       TEXT NOT NULL REFERENCES users(id),
  amount_micros INTEGER NOT NULL,
  kind          TEXT NOT NULL,   -- topup | usage | adjust
  ref           TEXT NOT NULL UNIQUE,
  created_at    INTEGER NOT NULL
);
CREATE INDEX ledger_user ON ledger(user_id, created_at);
