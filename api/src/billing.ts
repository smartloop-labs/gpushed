import type { Env } from "./env";
import { numVar } from "./env";
import { dispatchProvision, sendEmail } from "./external";
import { chargeMicros } from "./pricing";
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
  created_at: number;
  updated_at: number;
}

export interface User {
  id: string;
  email: string;
  balance_micros: number;
  low_balance_warned: number;
  exhausted_at: number | null;
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

// Charge the box's owner for usage since metered_until. The ledger ref is
// keyed on the start of the window, so two concurrent runs can't both charge
// it: the second one's batch fails on the unique ref and rolls back.
export async function meterBox(env: Env, box: Box, now: number): Promise<Box> {
  if (box.metered_until == null || now <= box.metered_until) return box;
  const amount = chargeMicros(meterRate(box), now - box.metered_until);
  const stmts: D1PreparedStatement[] = [];
  if (amount > 0) {
    stmts.push(
      env.DB.prepare(
        "INSERT INTO ledger (user_id, amount_micros, kind, ref, created_at) VALUES (?1, ?2, 'usage', ?3, ?4)",
      ).bind(box.user_id, -amount, `usage:${box.id}:${box.metered_until}`, now),
      env.DB.prepare("UPDATE users SET balance_micros = balance_micros - ?1 WHERE id = ?2").bind(amount, box.user_id),
    );
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

// Add money to a balance. Returns false when ref was already credited.
export async function credit(env: Env, userId: string, micros: number, kind: string, ref: string, now: number): Promise<boolean> {
  try {
    await env.DB.batch([
      env.DB.prepare(
        "INSERT INTO ledger (user_id, amount_micros, kind, ref, created_at) VALUES (?1, ?2, ?3, ?4, ?5)",
      ).bind(userId, micros, kind, ref, now),
      env.DB.prepare(
        `UPDATE users SET balance_micros = balance_micros + ?1,
           low_balance_warned = CASE WHEN balance_micros + ?1 > 0 THEN 0 ELSE low_balance_warned END,
           exhausted_at = CASE WHEN balance_micros + ?1 > 0 THEN NULL ELSE exhausted_at END
         WHERE id = ?2`,
      ).bind(micros, userId),
    ]);
    return true;
  } catch (e) {
    if (isUniqueViolation(e)) return false;
    throw e;
  }
}

// Cron: bill every box with a live VM, warn users running low, stop boxes
// whose owner is about to run out, and destroy them once the balance has been
// at or below zero for the grace period.
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

  const lowMicros = numVar(env.LOW_BALANCE_USD, 2) * 1e6;
  const { results: low } = await env.DB.prepare(
    `SELECT * FROM users u WHERE u.low_balance_warned = 0 AND u.balance_micros > 0 AND u.balance_micros <= ?1
       AND EXISTS (SELECT 1 FROM boxes b WHERE b.user_id = u.id AND b.status IN ('running', 'starting', 'pending'))`,
  )
    .bind(lowMicros)
    .all<User>();
  for (const u of low) {
    try {
      await sendEmail(
        env,
        u.email,
        "gpushed: your balance is running low",
        `Your gpushed balance is $${usd(u.balance_micros)}. When it reaches $0 your GPU box is stopped, ` +
          `and it is deleted ${env.STOPPED_GRACE_HOURS} hours later unless you top up.\n\n` +
          `Top up with: gpushed topup\n`,
      );
      await env.DB.prepare("UPDATE users SET low_balance_warned = 1 WHERE id = ?1").bind(u.id).run();
    } catch (e) {
      console.error(`low-balance warning for ${u.id} failed`, e);
    }
  }

  await env.DB.prepare("UPDATE users SET exhausted_at = ?1 WHERE balance_micros <= 0 AND exhausted_at IS NULL")
    .bind(now)
    .run();

  const graceSec = numVar(env.STOPPED_GRACE_HOURS, 24) * 3600;
  const { results: broke } = await env.DB.prepare(
    `SELECT b.*, u.email AS email, u.balance_micros AS balance_micros, u.exhausted_at AS exhausted_at FROM boxes b JOIN users u ON u.id = b.user_id
       WHERE b.metered_until IS NOT NULL AND (
         -- Stop a running box while ~10 minutes of credit is left (the cron runs
         -- every 5 and stopping takes a few), so balances barely go negative.
         (b.status = 'running' AND u.balance_micros <= b.hourly_micros / 6)
         OR (b.status IN ('stopped', 'failed') AND u.balance_micros <= 0))`,
  ).all<Box & { email: string; balance_micros: number; exhausted_at: number | null }>();
  for (const box of broke) {
    try {
      if (box.status === "running") {
        await updateBox(env, box, { status: "stopping" }, now);
        await dispatchProvision(env, "stop", box.id);
        await sendEmail(
          env,
          box.email,
          "gpushed: your GPU box was stopped",
          `Your gpushed balance is nearly used up ($${usd(box.balance_micros)}), so your box ${box.id} has been stopped. Its disk is kept for ` +
            `${env.STOPPED_GRACE_HOURS} hours; top up and run \`gpushed start\` to resume it, or it will be deleted.\n`,
        );
      } else if (box.exhausted_at != null && box.exhausted_at <= now - graceSec) {
        // Stopped (or stuck in failed) with no money for the whole grace period.
        await updateBox(env, box, { status: "destroying" }, now);
        await dispatchProvision(env, "down", box.id);
      }
    } catch (e) {
      console.error(`enforcing balance on ${box.id} failed`, e);
    }
  }
}
