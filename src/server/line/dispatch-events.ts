import type { Client } from "pg";
import { readLineConfig, type LineEnv } from "./config";

export type VendorDispatchChange = "shared" | "revoked";

/**
 * B-039 producer, called inside the committed business transaction (sharing approval / job revoke) on the
 * caller's service client. Env OFF adds no query; org `line_dispatch_push` not strictly true is one read and
 * no write. The SQL gateway rechecks every strict gate and the current job/assignment. A producer fault rolls
 * back only its savepoint and never fails or changes the existing dispatch. Sends nothing.
 */
export async function recordVendorDispatchEvent(c: Client, orgId: string, ticketId: string, jobId: string,
  change: VendorDispatchChange, env: LineEnv = process.env): Promise<string | null> {
  if (!readLineConfig(env).platformEnabled) return null;
  const org = (await c.query<{ enabled: boolean | null }>(
    "SELECT (feature_flags->'line_dispatch_push')='true'::jsonb AS enabled FROM public.organizations WHERE id=$1", [orgId])).rows[0];
  if (org?.enabled !== true) return null;
  await c.query("SAVEPOINT b039_dispatch_event");
  try {
    const id = (await c.query<{ id: string | null }>("SELECT app.b039_dispatch_event_record($1,$2,$3,$4) AS id",
      [orgId, ticketId, jobId, change])).rows[0]?.id ?? null;
    await c.query("RELEASE SAVEPOINT b039_dispatch_event");
    return id;
  } catch (error) {
    await c.query("ROLLBACK TO SAVEPOINT b039_dispatch_event");
    const code = (error as { code?: unknown })?.code;
    console.error("b039_dispatch_event_skipped", { code: typeof code === "string" && /^[0-9A-Z]{5}$/.test(code) ? code : "unknown" });
    return null;
  }
}
