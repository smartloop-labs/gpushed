-- Credits now live in the smartloop API's wallet, shared with smartloop.
-- users.balance_micros stays as a copy of what that wallet and the plan's
-- credits make available (refreshed on every meter tick and account read),
-- so the low-balance, stop and delete rules keep reading it.
--
-- wallet_migrated_at: when this account's old gpushed balance was moved into
-- the smartloop wallet (once; see ensureMigrated in src/billing.ts).
ALTER TABLE users ADD COLUMN wallet_migrated_at INTEGER;
