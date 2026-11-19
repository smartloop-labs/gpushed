import type { Env } from "./env";
import { numVar } from "./env";
import { dispatchProvision, sendEmail } from "./external";
import { chargeMicros } from "./pricing";
import { type Credits, getCredits, grantCredits, spendCredits } from "./smartloop";
import { isUniqueViolation, usd } from "./util";

export type BoxStatus =
  | "pending"
  | "running"
  | "stopping"
  | "stopped"
  | "starting"
  | "destroying"
  | "destroyed"
  | "failed";

export interface Box {
  id: string;
  user_id: string;
  plan: string;
  status: BoxStatus;
  region: string; // where it runs (until placed: the first region to try)
  regions: string; // comma-separated regions to try for a new box, in order
  zone: string | null;
  ip: string | null;
  ssh_public_key: string;
  hourly_micros: number;
  stopped_hourly_micros: number;
  metered_until: number | null;
  stopped_at: number | null;
  error: string | null;
  progress: string | null; // provisioner's current step, while one runs
  created_at: number;
  updated_at: number;
}

export interface User {
  id: string;
  email: string;
  // A copy of what the smartloop wallet and plan credits make available
  // (src/smartloop.ts holds the money); refreshed by syncBalance.
  balance_micros: number;
  low_balance_warned: number;
  exhausted_at: number | null;
  wallet_migrated_at?: number | null;
  unlimited?: number; // 1: GPU time is unlimited (a smartloop Partner)
  // Not stored: the smartloop plan, when withCredits has just read it.
  plan?: string;
  created_at: number;
}

// Hourly rate the box is billed at in its current state. A VM is billed from
// the moment Terraform reports it created (metered_until set) until it's
// destroyed; while stopped only its disk is billed.
export function meterRate(box: Pick<Box, "status" | "metered_until" | "stopped_at" | "hourly_micros" | "stopped_hourly_micros">): number {
  if (box.metered_until == null) return 0;
  switch (box.status) {
    case "pending":
    case "destroyed":
      return 0;
    case "stopped":
    case "starting":
      return box.stopped_hourly_micros;
    case "destroying":
    case "failed":
      return box.stopped_at != null ? box.stopped_hourly_micros : box.hourly_micros;
    default:
      return box.hourly_micros;
  }
}

export async function getBox(env: Env, id: string): Promise<Box | null> {
  return env.DB.prepare("SELECT * FROM boxes WHERE id = ?1").bind(id).first<Box>();
}

// Move an account's old gpushed balance into the smartloop wallet, once. Runs
// before anything spends or reads credits for the account, so no box is
// stopped for want of a move that hasn't happened yet. The grant's ref makes a
// concurrent second move a no-op; a negative old balance is left behind.
export async function ensureMigrated(env: Env, userId: string, now: number): Promise<void> {
  const u = await env.DB.prepare("SELECT balance_micros, wallet_migrated_at FROM users WHERE id = ?1")
    .bind(userId)
    .first<{ balance_micros: number; wallet_migrated_at: number | null }>();
  if (!u || u.wallet_migrated_at != null) return;
  if (u.balance_micros > 0) {
    await grantCredits(env, userId, u.balance_micros, "gpushed_migration", `gpushed-migration:${userId}`);
  }
  await env.DB.prepare("UPDATE users SET wallet_migrated_at = ?1 WHERE id = ?2 AND wallet_migrated_at IS NULL")
    .bind(now, userId)
    .run();
}

// Store what smartloop says the account can spend. Clears the "out of money"
// marks once there's money again, and re-arms the low-balance email once the
// balance is back above the warning line, as a top-up used to.
export async function syncBalance(env: Env, userId: string, availableMicros: number, unlimited = false): Promise<void> {
  const lowMicros = numVar(env.LOW_BALANCE_USD, 2) * 1e6;
  await env.DB.prepare(
    `UPDATE users SET balance_micros = ?1, unlimited = ?4,
       low_balance_warned = CASE WHEN ?1 > ?2 THEN 0 ELSE low_balance_warned END,
       exhausted_at = CASE WHEN ?1 > 0 OR ?4 = 1 THEN NULL ELSE exhausted_at END
     WHERE id = ?3`,
  )
    .bind(availableMicros, lowMicros, userId, unlimited ? 1 : 0)
    .run();
}

// Fetch the account's credits from smartloop and store them; returns them.
export async function refreshBalance(env: Env, userId: string, now: number): Promise<Credits> {
  await ensureMigrated(env, userId, now);
  const credits = await getCredits(env, userId);
  await syncBalance(env, userId, credits.available_micros, !!credits.unlimited);
  return credits;
}

// Charge the box's owner for usage since metered_until: smartloop spends the
// plan's credits first, then the wallet. The spend's ref is keyed on the
// start of the window, so a retried or concurrent run charges it once
// (smartloop replays it), and the local ledger row (usage history) is unique
// on the same ref, so the second run's batch fails and rolls back.
export async function meterBox(env: Env, box: Box, now: number): Promise<Box> {
  if (box.metered_until == null || now <= box.metered_until) return box;
  const amount = chargeMicros(meterRate(box), now - box.metered_until);
  const ref = `usage:${box.id}:${box.metered_until}`;
  const stmts: D1PreparedStatement[] = [];
  if (amount > 0) {
    await ensureMigrated(env, box.user_id, now);
    const spent = await spendCredits(env, box.user_id, amount, ref);
    stmts.push(
      env.DB.prepare(
        "INSERT INTO ledger (user_id, amount_micros, kind, ref, created_at) VALUES (?1, ?2, 'usage', ?3, ?4)",
      ).bind(box.user_id, -amount, ref, now),
    );
    await syncBalance(env, box.user_id, spent.available_micros, !!spent.unlimited);
  }
  stmts.push(
    env.DB.prepare("UPDATE boxes SET metered_until = ?1 WHERE id = ?2 AND metered_until = ?3").bind(
      now,
      box.id,
      box.metered_until,
    ),
  );
  try {
    await env.DB.batch(stmts);
  } catch (e) {
    if (isUniqueViolation(e)) return (await getBox(env, box.id)) ?? box;
    throw e;
  }
  return { ...box, metered_until: now };
}

// Bill usage up to now, then change the box. Fields are column => value.
export async function updateBox(
  env: Env,
  box: Box,
  fields: Partial<Omit<Box, "id" | "user_id">>,
  now: number,
): Promise<Box> {
  const metered = await meterBox(env, box, now);
  const all = { ...fields, updated_at: now };
  const cols = Object.keys(all);
  const sql = `UPDATE boxes SET ${cols.map((c, i) => `${c} = ?${i + 2}`).join(", ")} WHERE id = ?1`;
  await env.DB.prepare(sql)
    .bind(box.id, ...cols.map((c) => (all as Record<string, unknown>)[c] ?? null))
    .run();
  return { ...metered, ...all } as Box;
}

// Record a top-up in gpushed's own history (the usage chart and the welcome
// email count these); the money itself went to the smartloop wallet. Returns
// false when ref was already recorded.
export async function recordTopup(env: Env, userId: string, micros: number, ref: string, now: number): Promise<boolean> {
  try {
    await env.DB.prepare("INSERT INTO ledger (user_id, amount_micros, kind, ref, created_at) VALUES (?1, ?2, 'topup', ?3, ?4)")
      .bind(userId, micros, ref, now)
      .run();
    return true;
  } catch (e) {
    if (isUniqueViolation(e)) return false;
    throw e;
  }
}

// Cron: bill every box with a live VM, warn users running low, stop boxes
// whose owner is about to run out, and destroy them once the balance has been
// at or below zero for the grace period.
// After a credited top-up: when it's the account's first, send the gpushed
// welcome email. A failed send is logged and not retried (the credit is what
// matters), and a redelivered Stripe event doesn't credit, so never re-sends.
export async function welcomeOnFirstTopup(env: Env, userId: string): Promise<boolean> {
  const u = await env.DB.prepare(
    "SELECT email, balance_micros, (SELECT COUNT(*) FROM ledger WHERE user_id = ?1 AND kind = 'topup') AS topups FROM users WHERE id = ?1",
  )
    .bind(userId)
    .first<{ email: string; balance_micros: number; topups: number }>();
  if (!u || u.topups !== 1) return false;
  try {
    await sendEmail(env, u.email, "Welcome to gpushed: your credit is ready", welcomeText(u.balance_micros));
    return true;
  } catch (e) {
    console.error(`welcome email for ${userId} failed`, e);
    return false;
  }
}

export function welcomeText(balanceMicros: number): string {
  return (
    `Welcome to gpushed! Your balance is $${usd(balanceMicros)}, so you can start a GPU box now.\n\n` +
    `  gpushed plans        prices for the A100, L4 and Tesla T4\n` +
    `  gpushed up           start a box (the L4 by default; gpushed up a100 for the big one)\n` +
    `  gpushed ssh          connect to it\n` +
    `  gpushed stop         stop it; you pay only for its disk while it's stopped\n` +
    `  gpushed down         delete it when you're done\n\n` +
    `Boxes boot with the NVIDIA driver, CUDA, Python and dev tools ready, and are billed per second ` +
    `from your balance. We email you when it runs low; add credits any time with: gpushed topup. Your smartloop plan credits are spent first.\n\n` +
    `Docs and FAQ: https://gpushed.dev\n`
  );
}

export async function runMetering(env: Env, now: number): Promise<void> {
  const { results: live } = await env.DB.prepare(
    "SELECT * FROM boxes WHERE metered_until IS NOT NULL AND status != 'destroyed'",
  ).all<Box>();
  for (const box of live) {
    try {
      await meterBox(env, box, now);
    } catch (e) {
      console.error(`metering ${box.id} failed`, e);
    }
  }

  // Credits can change outside gpushed (a top-up on smartloop, cloud model
  // use spending the same plan credits), so read every box owner's from
  // smartloop before warning, stopping or deleting anything. An owner whose
  // read failed is left alone this run rather than judged on a stale copy.
  const fresh = new Set<string>();
  for (const userId of new Set(live.map((b) => b.user_id))) {
    try {
      await refreshBalance(env, userId, now);
      fresh.add(userId);
    } catch (e) {
      console.error(`reading credits for ${userId} failed`, e);
    }
  }

  const lowMicros = numVar(env.LOW_BALANCE_USD, 2) * 1e6;
  const { results: low } = await env.DB.prepare(
    `SELECT * FROM users u WHERE u.low_balance_warned = 0 AND u.unlimited = 0 AND u.balance_micros > 0 AND u.balance_micros <= ?1
       AND EXISTS (SELECT 1 FROM boxes b WHERE b.user_id = u.id AND b.status IN ('running', 'starting', 'pending'))`,
  )
    .bind(lowMicros)
    .all<User>();
  for (const u of low) {
    if (!fresh.has(u.id)) continue;
    try {
      await sendEmail(
        env,
        u.email,
        "gpushed: your balance is running low",
        `Your gpushed balance is $${usd(u.balance_micros)}. When it reaches $0 your GPU box is stopped, ` +
          `and it is deleted ${env.STOPPED_GRACE_HOURS} hours later unless you add credits.\n\n` +
          `Add credits with: gpushed topup (or in Billing on app.smartloop.ai)\n`,
      );
      await env.DB.prepare("UPDATE users SET low_balance_warned = 1 WHERE id = ?1").bind(u.id).run();
    } catch (e) {
      console.error(`low-balance warning for ${u.id} failed`, e);
    }
  }

  await env.DB.prepare("UPDATE users SET exhausted_at = ?1 WHERE balance_micros <= 0 AND unlimited = 0 AND exhausted_at IS NULL")
    .bind(now)
    .run();

  const graceSec = numVar(env.STOPPED_GRACE_HOURS, 24) * 3600;
  const { results: broke } = await env.DB.prepare(
    `SELECT b.*, u.email AS email, u.balance_micros AS balance_micros, u.exhausted_at AS exhausted_at FROM boxes b JOIN users u ON u.id = b.user_id
       WHERE b.metered_until IS NOT NULL AND u.unlimited = 0 AND (
         -- Stop a running box while ~10 minutes of credit is left (the cron runs
         -- every 5 and stopping takes a few), so balances barely go negative.
         (b.status = 'running' AND u.balance_micros <= b.hourly_micros / 6)
         OR (b.status IN ('stopped', 'failed') AND u.balance_micros <= 0))`,
  ).all<Box & { email: string; balance_micros: number; exhausted_at: number | null }>();
  for (const box of broke) {
    if (!fresh.has(box.user_id)) continue;
    try {
      if (box.status === "running") {
        const stopping = await updateBox(env, box, { status: "stopping" }, now);
        if (!(await dispatchOrRevert(env, stopping, "stop", "running", now))) continue;
        await sendEmail(
          env,
          box.email,
          "gpushed: your GPU box was stopped",
          `Your gpushed balance is nearly used up ($${usd(box.balance_micros)}), so your box ${box.id} has been stopped. Its disk is kept for ` +
            `${env.STOPPED_GRACE_HOURS} hours; add credits and run \`gpushed start\` to resume it, or it will be deleted.\n`,
        );
      } else if (box.exhausted_at != null && box.exhausted_at <= now - graceSec) {
        // Stopped (or stuck in failed) with no money for the whole grace period.
        const destroying = await updateBox(env, box, { status: "destroying" }, now);
        await dispatchOrRevert(env, destroying, "down", box.status, now);
      }
    } catch (e) {
      console.error(`enforcing balance on ${box.id} failed`, e);
    }
  }

  await retryStuckProvisions(env, now);
}

// Ask the provisioner to run `action` on a box the cron just moved into
// stopping/destroying. If GitHub can't be reached, put the box back in
// `revertTo` so the next run (5 minutes later) tries again; left in
// stopping/destroying, the balance check would never select it again.
export async function dispatchOrRevert(
  env: Env,
  box: Box,
  action: "stop" | "down",
  revertTo: BoxStatus,
  now: number,
): Promise<boolean> {
  try {
    await dispatchProvision(env, action, box.id);
    return true;
  } catch (e) {
    console.error(`dispatching ${action} for ${box.id} failed; back to ${revertTo} to retry`, e);
    await updateBox(env, box, { status: revertTo }, now);
    return false;
  }
}

// The provision job times out after 30 minutes (.github/workflows/provision.yml);
// allow for queueing behind another run of the same box.
export const STUCK_AFTER_SEC = 45 * 60;

// A stop or delete whose provisioner run never reported back (its dispatch was
// lost, or the run was cancelled or timed out) leaves the box stopping or
// destroying for good: a stopping box bills at the full GPU rate and is never
// stopped or deleted. Dispatch the action again; both are idempotent, and the
// report of a stale run is ignored once the box has moved on.
export async function retryStuckProvisions(env: Env, now: number): Promise<void> {
  const { results: stuck } = await env.DB.prepare(
    "SELECT * FROM boxes WHERE status IN ('stopping', 'destroying') AND updated_at <= ?1",
  )
    .bind(now - STUCK_AFTER_SEC)
    .all<Box>();
  for (const box of stuck) {
    const action = box.status === "stopping" ? "stop" : "down";
    try {
      console.warn(`box ${box.id} has been ${box.status} since ${box.updated_at}; dispatching ${action} again`);
      // Touch updated_at first, so a box is retried at most every STUCK_AFTER_SEC.
      await updateBox(env, box, {}, now);
      await dispatchProvision(env, action, box.id);
    } catch (e) {
      console.error(`retrying ${action} for ${box.id} failed`, e);
    }
  }
}
