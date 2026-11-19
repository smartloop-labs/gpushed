-- unlimited: smartloop says the account's GPU time is unlimited (a Partner).
-- Its boxes are metered for usage history but never charged, warned about a
-- low balance, stopped or deleted for want of credit. Refreshed with the
-- balance (syncBalance in src/billing.ts).
ALTER TABLE users ADD COLUMN unlimited INTEGER NOT NULL DEFAULT 0;
