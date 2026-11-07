import { svc } from "../db";
import { lineRepairLocale, lineRepairMessage, type LineRepairKind } from "@/i18n/line-repair-push";
import { readLineConfig, type LineEnv } from "./config";
import { dispatchLinePush, LINE_TRANSPORT_TIMEOUT_MS } from "./quota";
import type { LineTransport } from "./transport";

export type RepairPersona = "tenant" | "owner";
/** Trusted transient service input. The LINE user id and pepper are never persisted or logged. */
export type RepairTargetResolver = (recipient: { orgId: string; contactId: string; persona: RepairPersona; channelId: string })
  => Promise<{ to: string; identityPepper: string } | null>;
export type RepairPushResult = { notificationId: string; status: string; reason?: string };

type Claim = { notification_id: string; claim_id: string; token: string; persona: RepairPersona; recipient_contact_id: string;
  source_kind: LineRepairKind; channel_id: string | null };
type Context = { authority: "ok" | "revoked" | "superseded" | "disabled"; channel_id: string | null; liff_id: string | null;
  locale: string | null; kind: LineRepairKind; ticket_number: number | null; status_to: string | null; version_no: string | null };

export const REPAIR_TARGET_TIMEOUT_MS = 5_000;
/** Claim lease covers the bounded target lookup, the bounded transport call and a margin. */
export const REPAIR_PUSH_CLAIM_TTL_SECONDS = 120;
if (REPAIR_PUSH_CLAIM_TTL_SECONDS * 1000 < 4 * (REPAIR_TARGET_TIMEOUT_MS + LINE_TRANSPORT_TIMEOUT_MS)) throw new Error("claim TTL too short");

/** LIFF entry for the recipient persona. Carries only the organization id: no token, ticket content or LINE id. */
export function repairLiffLink(liffId: string, orgId: string) {
  return `https://liff.line.me/${encodeURIComponent(liffId)}?org=${encodeURIComponent(orgId)}`;
}

async function boundedTarget(resolve: RepairTargetResolver, input: Parameters<RepairTargetResolver>[0]) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([resolve(input),
      new Promise<null>(done => { timer = setTimeout(() => done(null), REPAIR_TARGET_TIMEOUT_MS); })]);
  } catch { return null; } finally { if (timer) clearTimeout(timer); }
}

/** A lost/expired claim (42501) means another worker owns the row now; never abort the run. */
async function finish(orgId: string, claim: Claim, outcome: "accepted" | "fallback" | "requeue", reason: string | null = null) {
  try {
    await svc(null, c => c.query("SELECT app.b038_repair_complete($1,$2,$3,$4,$5)",
      [orgId, claim.notification_id, claim.token, outcome, reason]));
    return true;
  } catch { return false; }
}

/**
 * Local worker for committed repair status and owner approval events (B-038). The caller
 * authorizes running for this organization. Authority is rechecked by the context gateway and
 * again inside the shared B-033 decision transaction (`authorize` hook) with the authority rows
 * locked. Delivery, quota, guard and Email fallback are the shared B-033/B-028 paths.
 * `beforeDispatch` is a test seam between the two checks. Captured transport only.
 */
export async function runLineRepairPushes(orgId: string, options: {
  transport: Pick<LineTransport, "push">; resolveTarget: RepairTargetResolver; env?: LineEnv; limit?: number; timeoutMs?: number;
  beforeDispatch?: (notificationId: string) => Promise<void>;
}) {
  const env = options.env ?? process.env;
  const results: RepairPushResult[] = [];
  // Global kill: no query, no write and no transport call.
  if (!readLineConfig(env).platformEnabled) return { enqueued: 0, results };
  // A failed scan (e.g. lock timeout) rolls back and is retried next run; queued rows still drain.
  let enqueued = 0;
  try {
    enqueued = await svc(null, async c => (await c.query<{ n: number }>(
      "SELECT app.b038_repair_enqueue($1) AS n", [orgId])).rows[0].n);
  } catch { results.push({ notificationId: "", status: "enqueue_error" }); }
  const limit = Math.max(1, Math.min(options.limit ?? 25, 100)), handled: string[] = [];
  for (let i = 0; i < limit; i++) {
    // Rows handled this run are excluded, so a requeued row never starves later rows.
    // Per-row failures are isolated in SQL; an unexpected claim failure ends this run only.
    let claim: Claim | undefined;
    try {
      claim = (await svc(null, async c => (await c.query<Claim>(
        "SELECT * FROM app.b038_repair_claim($1,1,$2,$3::uuid[])", [orgId, REPAIR_PUSH_CLAIM_TTL_SECONDS, handled])).rows))[0];
    } catch { results.push({ notificationId: "", status: "claim_error" }); break; }
    if (!claim) break;
    handled.push(claim.notification_id);
    const push = (status: string, reason?: string | null) =>
      results.push({ notificationId: claim.notification_id, status, ...(reason ? { reason } : {}) });
    try {
      // Resolve the transient target first; both authority checks follow it.
      const target = claim.channel_id ? await boundedTarget(options.resolveTarget, { orgId,
        contactId: claim.recipient_contact_id, persona: claim.persona, channelId: claim.channel_id }) : null;
      const ctx = (await svc(null, async c => (await c.query<Context>(
        "SELECT * FROM app.b038_repair_context($1,$2,$3)", [orgId, claim.notification_id, claim.token])).rows))[0];
      if (!ctx || ctx.authority === "disabled") { await finish(orgId, claim, "requeue"); push("disabled"); break; }
      if (ctx.authority === "ok" && ctx.channel_id && ctx.channel_id !== claim.channel_id) {
        await finish(orgId, claim, "requeue"); push("channel_changed"); continue; // re-resolve next run
      }
      if (ctx.authority !== "ok" || !ctx.channel_id) {
        const reason = ctx.authority === "revoked" ? "repair_authority_revoked"
          : ctx.authority === "superseded" ? "repair_superseded" : "line_unavailable";
        const row = (await svc(null, async c => (await c.query<{ state: string; reason: string | null }>(
          "SELECT * FROM app.b038_repair_withhold($1,$2,$3,$4)", [orgId, claim.notification_id, claim.token, reason])).rows))[0];
        push(row?.state ?? "unknown", row?.reason); continue;
      }
      // Built in memory only after the authority recheck; never persisted.
      const text = lineRepairMessage(lineRepairLocale(ctx.locale), { kind: ctx.kind, ticketNumber: Number(ctx.ticket_number ?? 0),
        status: ctx.status_to, versionNo: ctx.version_no === null ? null : Number(ctx.version_no),
        link: repairLiffLink(ctx.liff_id ?? "", orgId) });
      if (options.beforeDispatch) await options.beforeDispatch(claim.notification_id);
      // A missing/mismatched target fails the B-033 identity guard: no push, line_guard Email fallback.
      const outcome: { status: string; reason?: string; emailClaim?: string } = await dispatchLinePush({ orgId,
        notificationId: claim.notification_id, claimId: claim.claim_id, channelId: ctx.channel_id, persona: claim.persona,
        to: target?.to ?? "", identityPepper: target?.identityPepper ?? "", messages: [{ type: "text", text }] },
      options.transport, env, { timeoutMs: options.timeoutMs, authorize: { deniedReason: "repair_authority_revoked",
        check: async c => (await c.query<{ a: "allow" | "deny" | "skip" }>(
          "SELECT app.b038_repair_authorize($1,$2,$3) AS a", [orgId, claim.notification_id, claim.token])).rows[0].a } });
      if (outcome.status === "accepted") await finish(orgId, claim, "accepted");
      // Only a durable B-033 fallback (with its Email claim) is terminal. A disabled dispatcher,
      // deferred/busy owner or unknown provider result keeps the same claim id for a later run;
      // past the SLA the claim gateway closes it with the deduplicated Email fallback.
      else if (outcome.status === "skipped" && outcome.emailClaim) await finish(orgId, claim, "fallback", outcome.reason ?? null);
      else await finish(orgId, claim, "requeue");
      push(outcome.status, outcome.reason);
    } catch {
      await finish(orgId, claim, "requeue");
      push("error");
    }
  }
  return { enqueued, results };
}
