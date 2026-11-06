import { randomUUID } from "node:crypto";
import type { Client } from "pg";
import { svc } from "../db";
import { readLineConfig, type LineEnv } from "./config";
import type { LineMessage, LineTransport, PushOutcome } from "./transport";
import { providerUserHash } from "./webhook";

export type LinePush = {
  orgId: string; notificationId: string; claimId: string; channelId: string;
  persona: "tenant" | "owner" | "vendor";
  // Transient trusted service input. Never persisted in new tables or log output.
  to: string; identityPepper: string; messages: readonly LineMessage[];
};
type Context = { recipient_contact_id: string; link_id: string | null; line_provider_id: string;
  provider_user_hash: string | null; eligible: boolean; fallback_ready: boolean; enabled: boolean };
type Reservation = { period_month: string; status: "reserved" | "dispatching" | "unknown" | "settled" | "released" | "expired" | "line_budget" | "fallback"; pushed_count: number; reserved_count: number };
async function context(c: Client, req: LinePush): Promise<Context | undefined> {
  // Slice-2 links own their persona; identity.persona only describes the first binding.
  // Preserve slice-1 eligibility for legacy links without a link persona.
  return (await c.query<Context>(`SELECT n.recipient_contact_id,ch.line_provider_id,l.id AS link_id,i.provider_user_hash,app.b028_delivery_enabled(n.org_id) AS fallback_ready,
    app.b033_push_enabled(n.org_id) AS enabled,
    (app.b033_push_enabled(n.org_id) IS TRUE AND ch.id=app.b033_selected_channel(n.org_id)
      AND ch.is_active AND ch.tenant_config_verified_at IS NOT NULL
      AND CASE $4 WHEN 'tenant' THEN ch.liff_id_tenant IS NOT NULL WHEN 'owner' THEN ch.liff_id_owner IS NOT NULL
        WHEN 'vendor' THEN ch.liff_id_vendor IS NOT NULL ELSE false END AND i.id IS NOT NULL AND i.status='linked' AND i.unlinked_at IS NULL
      AND CASE WHEN l.persona IS NULL THEN i.user_id=ct.user_id AND i.persona=$4
        ELSE l.persona=$4 AND i.user_id=app.b033_contact_user(l.org_id,l.contact_id,l.persona) END
      AND i.friend_state AND l.is_friend
      AND l.status='linked' AND l.unlinked_at IS NULL AND l.identity_verified_at IS NOT NULL
      AND l.notification_opt_in AND ct.archived_at IS NULL
      AND CASE $4 WHEN 'tenant' THEN ct.is_tenant WHEN 'owner' THEN ct.is_owner WHEN 'vendor' THEN ct.is_vendor ELSE false END) IS TRUE AS eligible
    FROM public.notifications n JOIN public.contacts ct ON ct.id=n.recipient_contact_id AND ct.org_id=n.org_id
    JOIN public.line_channels ch ON ch.id=$3
    LEFT JOIN public.line_account_links l ON l.org_id=n.org_id AND l.contact_id=ct.id AND l.line_channel_id=ch.id AND l.status='linked'
    LEFT JOIN app.b033_line_identities i ON i.id=l.login_identity_id AND i.line_channel_id=ch.id
    WHERE n.org_id=$1 AND n.id=$2`, [req.orgId, req.notificationId, req.channelId, req.persona])).rows[0];
}
async function delivery(c: Client, req: LinePush, ctx: Context, channel: "line" | "email", claim: string,
  status: "skipped" | "queued" | "sent" | "failed", reason: string | null, counted = false) {
  await c.query(`INSERT INTO public.deliveries(org_id,notification_id,recipient_contact_id,line_account_link_id,line_channel_id,
    channel,provider,status,error,counts_toward_quota,b033_claim_id,sent_at)
    VALUES($1,$2,$3,$4,$5,$6::public.channel_type,$7,$8::public.delivery_status,$9,$10,$11,CASE WHEN $8::public.delivery_status='sent' THEN now() ELSE NULL END)
    ON CONFLICT(b033_claim_id,channel) WHERE b033_claim_id IS NOT NULL DO UPDATE
    SET status=excluded.status,error=excluded.error,counts_toward_quota=excluded.counts_toward_quota,sent_at=excluded.sent_at
    WHERE deliveries.status='queued' AND excluded.channel='line' `,
  [req.orgId, req.notificationId, ctx.recipient_contact_id, channel === "line" ? ctx.link_id : null,
    channel === "line" ? req.channelId : null, channel, channel === "line" ? "line_captured" : "b028_email",
    status, reason, counted, claim]);
}
export const LINE_TRANSPORT_TIMEOUT_MS = 10_000;
/** Called by the authorized local notification worker even when no retry is requested.
 * Never sends LINE or Email itself; only enqueues durable B-028 fallback claims. */
export async function expireLinePushes(orgId: string, env: LineEnv = process.env) {
  if (!readLineConfig(env).platformEnabled) return 0;
  return svc(null, async c => (await c.query<{ expired: number }>(
    "SELECT app.b033_push_expire($1) AS expired", [orgId])).rows[0].expired);
}
async function boundedPush(transport: Pick<LineTransport, "push">, req: LinePush, timeoutMs: number): Promise<PushOutcome> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      transport.push({ channelId: req.channelId, to: req.to, messages: req.messages,
        headers: { "X-Line-Retry-Key": req.claimId } }),
      new Promise<PushOutcome>(resolve => { timer = setTimeout(() => resolve({ status: "timeout" }), timeoutMs); }),
    ]);
  } catch { return { status: "timeout" }; }
  finally { if (timer) clearTimeout(timer); }
}
/** Business caller authorizes notification scope. There are no legacy producer callers in slice 1. */
/** Optional business re-authorization, run inside the decision transaction after the claim lock and
 * before any reservation, start or provider call. "deny" records the deduplicated Email fallback with
 * `deniedReason`; "skip" defers without writes. Existing callers omit it and are unchanged. */
export type LinePushAuthorize = { check: (c: Client) => Promise<"allow" | "deny" | "skip">; deniedReason: string };
export async function dispatchLinePush(req: LinePush, transport: Pick<LineTransport, "push">, env: LineEnv = process.env,
  options: { timeoutMs?: number; authorize?: LinePushAuthorize } = {}) {
  const config = readLineConfig(env), owner = randomUUID();
  let ctx: Context | undefined;
  let reservation: Reservation | undefined;
  let state: string | undefined;
  let fallbackResult: Awaited<ReturnType<typeof fallback>> | undefined;
  async function fallback(c: Client, why: string, dispatchOwner: string | null = null) {
    const row = (await c.query<{ state: string; email_claim: string | null; reason: string | null }>(
      "SELECT * FROM app.b033_push_fallback($1,$2,$3,$4,$5,$6)",
      [req.channelId, req.claimId, req.orgId, req.notificationId, why, dispatchOwner])).rows[0];
    return { status: row.state, ...(row.reason ? { reason: row.reason } : {}), ...(row.email_claim ? { emailClaim: row.email_claim } : {}) };
  }
  try {
    await svc(null, async c => {
      ctx = await context(c, req);
      if (!ctx) throw new Error("Notification unavailable");
      if (!ctx.fallback_ready) { state = "fallback_unavailable"; return; }
      if (!config.platformEnabled || !ctx.enabled) { state = "disabled"; return; }
      // Serialize the decision before inspecting health. Settled/fallback claims never
      // change channel on replay, even when configuration or identity later changes.
      await c.query("SELECT pg_advisory_xact_lock(hashtextextended($1,33))", [req.claimId]);
      const prior = (await c.query<{ status: string; org_id: string; notification_id: string; line_channel_id: string }>(
        "SELECT * FROM app.b033_push_reservations WHERE claim_id=$1 FOR UPDATE NOWAIT", [req.claimId])).rows[0];
      const terminal = (await c.query<{ org_id: string; notification_id: string; line_channel_id: string }>(
        "SELECT * FROM app.b033_push_fallbacks WHERE claim_id=$1", [req.claimId])).rows[0];
      for (const row of [prior, terminal]) if (row && (row.org_id !== req.orgId || row.notification_id !== req.notificationId || row.line_channel_id !== req.channelId))
        throw new Error("Claim scope mismatch");
      if (terminal || prior?.status === "released") { fallbackResult = await fallback(c, "line_failed"); return; }
      if (prior?.status === "settled") { state = "settled"; return; }
      if (prior?.status === "expired") { fallbackResult = await fallback(c, "line_unknown_possible_duplicate"); return; }
      if (options.authorize) {
        const decision = await options.authorize.check(c);
        if (decision === "skip") { state = "deferred"; return; }
        if (decision !== "allow") { fallbackResult = await fallback(c, options.authorize.deniedReason); return; }
      }
      if (!config.guardReady || !ctx.eligible || !req.identityPepper ||
        !/^U[0-9a-f]{32}$/.test(req.to) || providerUserHash(ctx.line_provider_id, req.to, req.identityPepper) !== ctx.provider_user_hash) {
        fallbackResult = await fallback(c, "line_guard"); return;
      }
      reservation = (await c.query<Reservation>(
        "SELECT period_month::text,status,pushed_count,reserved_count FROM app.b033_push_reserve($1,$2,$3,$4,$5)",
        [req.channelId, req.claimId, req.orgId, req.notificationId, config.monthlyLimit])).rows[0];
      if (!reservation) {
        await c.query(`SELECT app.b033_quota_alert_once(line_channel_id,period_month) FROM public.line_push_usage
          WHERE line_channel_id=$1 AND period_month=date_trunc('month',now() AT TIME ZONE 'Asia/Taipei')::date
            AND pushed_count+reserved_count >= $2`, [req.channelId, config.monthlyLimit]);
        fallbackResult = await fallback(c, "line_quota");
      } else if (reservation.status === "line_budget" || reservation.status === "fallback") {
        fallbackResult = await fallback(c, "line_budget");
      } else {
        if (reservation.pushed_count + reservation.reserved_count >= config.monthlyLimit!) {
          await c.query("SELECT app.b033_quota_alert_once($1,$2)", [req.channelId, reservation.period_month]);
        }
        state = reservation.status === "expired" ? "expired" : (await c.query<{ state: string }>(
          "SELECT app.b033_push_start($1,$2) AS state", [req.claimId, owner])).rows[0].state;
        if (state === "dispatching") await delivery(c, req, ctx, "line", req.claimId, "queued", "line_dispatching");
        if (state === "expired" && !prior) fallbackResult = await fallback(c, "line_unknown_possible_duplicate");
      }
    });
  } catch {
    // Counter failures may fall back only after a new transaction rechecks flags and
    // durable claim ownership. Failed/uncertain authorization never permits writes.
    state = undefined; fallbackResult = undefined;
    if (!config.platformEnabled) return { status: "skipped", reason: "line_guard" };
    try { return await svc(null, c => fallback(c, "line_guard")); }
    catch { return { status: "unknown" }; }
  }
  if (fallbackResult) return fallbackResult;
  if (state === "disabled") return { status: "skipped", reason: "line_guard" };
  if (state === "fallback_unavailable") return { status: "fallback_unavailable" };
  if (state === "settled") return { status: "accepted" };
  if (state === "busy") return { status: "busy" };
  if (state === "deferred") return { status: "deferred" };
  if (state === "expired") {
    await expireLinePushes(req.orgId, env);
    return svc(null, c => fallback(c, "line_unknown_possible_duplicate"));
  }
  if (state !== "dispatching" || !ctx) return { status: "unknown" };
  const target = ctx;
  const requestedTimeout = options.timeoutMs ?? LINE_TRANSPORT_TIMEOUT_MS;
  const timeoutMs = Number.isFinite(requestedTimeout) && requestedTimeout > 0
    ? Math.min(requestedTimeout, LINE_TRANSPORT_TIMEOUT_MS) : LINE_TRANSPORT_TIMEOUT_MS;
  const outcome = await boundedPush(transport, req, timeoutMs);
  if (outcome.status === "accepted" || outcome.status === "duplicateAccepted") {
    const settled = await svc(null, async c => {
      const done = (await c.query<{ done: boolean }>("SELECT app.b033_push_settle($1,$2) AS done", [req.claimId, owner])).rows[0].done;
      if (done) await delivery(c, req, target, "line", req.claimId, "sent", null, true);
      return done;
    });
    if (settled) return { status: "accepted" as const };
    // A rejected/stale settlement cannot be reported as accepted or free quota.
    return { status: "unknown" as const };
  }
  if (outcome.status === "failed") {
    const result = await svc(null, c => fallback(c, "line_failed", owner));
    if (result.status !== "unknown") return result;
  }
  await svc(null, async c => {
    const marked = (await c.query("SELECT app.b033_push_unknown($1,$2) AS done", [req.claimId, owner])).rows[0].done;
    if (marked) await delivery(c, req, target, "line", req.claimId, "queued", "line_unknown");
  });
  await expireLinePushes(req.orgId, env);
  return { status: "unknown" as const };
}
