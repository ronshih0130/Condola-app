import type { Client } from "pg";
import { svc } from "../db";
import { FlowError } from "../errors";
import { makeT } from "../../i18n";
import { lockTicketThenJobs, vendorJobUrl } from "../vendor-repair";
import { hashVendorToken } from "../vendor-repair-rules";
import { readLineConfig, type LineEnv } from "./config";
import { LineError } from "./login-token";
import { dispatchLinePush, expireLinePushes, type LinePushAuthorize } from "./quota";
import type { LineMessage, LineTransport } from "./transport";
import { vendorScopeOn } from "./vendor-scope";

export type DispatchKind = "assigned" | "rescheduled" | "cancelled";
/** Server-only resolution of the raw LINE destination for a trusted link (identities keep only a keyed hash).
 * Never persisted or logged. `null` follows the shared B-033 guard path (Email fallback). */
export type DispatchRecipientResolver = (target: { orgId: string; channelId: string; linkId: string }) =>
  Promise<{ to: string; identityPepper: string } | null>;
type Pending = { notification_id: string; claim_id: string; kind: DispatchKind; job_id: string; ticket_id: string;
  vendor_contact_id: string; locale: string };
export type DispatchResult = { notificationId: string; kind: DispatchKind; status: string; reason?: string };

const isDenial = (error: unknown) => error instanceof LineError || (error instanceof FlowError && error.key === "errors.notFound");

/** Builds only the minimal job-scoped copy: no ticket title, address, cost, tenant or owner data. */
export function vendorDispatchMessages(kind: DispatchKind, locale: string, link: string | null): LineMessage[] {
  const t = makeT(locale === "en" ? "en" : "zh-TW");
  return [{ type: "text", text: t(`line_dispatch_${kind}`, link ? { link } : undefined) }];
}

type DependencyStatus = "pending" | "sent" | "fallback" | "superseded" | "uncertain";
/** "uncertain": an attempt may have reached LINE before authority went stale, so the vendor is treated as told. */
const announced = (status: DependencyStatus | null) => status === "sent" || status === "fallback" || status === "uncertain";

/** Rechecked under the dispatcher's decision transaction: gates, pending claim, the announcement this event follows,
 * current assignment and job authority. `expectAnnounced` is the dependency class the message copy was built for. */
function authorizeEvent(orgId: string, e: Pending, tokenHash: string | null, expectAnnounced: boolean | null): LinePushAuthorize {
  return async (c: Client) => {
    if ((await c.query<{ ok: boolean }>("SELECT app.b039_dispatch_push_enabled($1) AS ok", [orgId])).rows[0]?.ok !== true) return "off";
    const event = (await c.query<{ status: string; claim_id: string; dependency: DependencyStatus | null }>(
      `SELECT e.status,e.claim_id,d.status AS dependency FROM app.b039_dispatch_events e
       LEFT JOIN app.b039_dispatch_events d ON d.notification_id=e.depends_on WHERE e.notification_id=$1 AND e.org_id=$2`,
      [e.notification_id, orgId])).rows[0];
    if (!event || event.status !== "pending" || event.claim_id !== e.claim_id) return "stale";
    if (e.kind !== "assigned") {
      if (!event.dependency || event.dependency === "pending") return "defer";
      if (announced(event.dependency) !== expectAnnounced) return "defer"; // copy is rebuilt on the next run
      if (e.kind === "cancelled" && !announced(event.dependency)) return "stale";
    }
    try {
      if (e.kind === "cancelled") {
        await lockTicketThenJobs(c, orgId, e.ticket_id);
        // The cancellation goes to the party that was (possibly) told about this job, while that contact is active,
        // unless the same vendor already holds a newer active job on the ticket (a reschedule follows instead).
        const row = (await c.query<{ ok: boolean }>(`SELECT (j.revoked_at IS NOT NULL AND NOT j.active
            AND j.vendor_contact_id=$4 AND v.is_vendor AND v.archived_at IS NULL
            AND NOT EXISTS(SELECT 1 FROM repair_vendor_jobs n WHERE n.org_id=j.org_id AND n.ticket_id=j.ticket_id AND n.active
              AND n.vendor_contact_id=$4)) AS ok
          FROM repair_vendor_jobs j JOIN contacts v ON v.id=j.vendor_contact_id AND v.org_id=j.org_id
          WHERE j.id=$1 AND j.org_id=$2 AND j.ticket_id=$3`, [e.job_id, orgId, e.ticket_id, e.vendor_contact_id])).rows[0];
        return row?.ok === true ? "ok" : "stale";
      }
      if (!tokenHash) return "stale";
      // Same B-035 write scope the pushed link will be checked against: assignment, sharing, expiry, revocation, ticket.
      const scope = await vendorScopeOn(c, tokenHash, orgId, true);
      const job = (await c.query<{ vendor_contact_id: string | null }>(
        "SELECT vendor_contact_id FROM repair_vendor_jobs WHERE id=$1 AND org_id=$2", [scope.job_id, orgId])).rows[0];
      return scope.job_id === e.job_id && scope.ticket_id === e.ticket_id && job?.vendor_contact_id === e.vendor_contact_id ? "ok" : "stale";
    } catch (error) {
      if (isDenial(error)) return "stale";
      throw error;
    }
  };
}

/** The kind of notice the vendor receives: a reschedule whose previous announcement was never delivered is the first notice. */
export function announcedKind(kind: DispatchKind, dependency: DependencyStatus | null): DispatchKind {
  return kind === "rescheduled" && !announced(dependency) ? "assigned" : kind;
}

/**
 * Email fallback content rule for dispatch_* notifications (B-028's Email adapter is capture-only here; a future
 * renderer must use this). Same zh-TW/en key and wording as the LINE message: assigned → `line_dispatch_assigned`
 * with the job link; rescheduled → `line_dispatch_rescheduled` with the new job link, or the assigned wording when the
 * previous announcement was never delivered; cancelled → `line_dispatch_cancelled`, never a link. The link is the
 * job's current `/v/<token>` and is included only while the job is still open at render time; otherwise an
 * assigned/rescheduled Email is suppressed (the vendor must not receive a dead or stale capability).
 */
export function vendorDispatchEmailTemplate(input: { kind: DispatchKind; dependency: DependencyStatus | null; locale: string; link: string | null }):
  { templateKey: string; locale: "zh-TW" | "en"; text: string; link: string | null } | { suppressed: true } {
  const kind = announcedKind(input.kind, input.dependency), locale = input.locale === "en" ? "en" : "zh-TW";
  if (kind !== "cancelled" && !input.link) return { suppressed: true };
  const link = kind === "cancelled" ? null : input.link;
  return { templateKey: `line_dispatch_${kind}`, locale, text: vendorDispatchMessages(kind, locale, link)[0].text, link };
}
/** Loads the current event state for {@link vendorDispatchEmailTemplate}; null when the notification is not a dispatch event. */
export async function vendorDispatchEmailContent(orgId: string, notificationId: string, origin: string) {
  const row = await svc(null, async c => (await c.query<{ kind: DispatchKind; dependency: DependencyStatus | null; locale: string; token: string | null }>(
    `SELECT e.kind,d.status AS dependency,n.locale,(SELECT s.token FROM repair_vendor_secrets s JOIN repair_vendor_jobs j ON j.id=s.job_id
       WHERE s.job_id=e.job_id AND j.org_id=e.org_id AND j.active AND j.revoked_at IS NULL AND j.expires_at>clock_timestamp()) AS token
     FROM app.b039_dispatch_events e JOIN public.notifications n ON n.id=e.notification_id AND n.org_id=e.org_id
     LEFT JOIN app.b039_dispatch_events d ON d.notification_id=e.depends_on WHERE e.org_id=$1 AND e.notification_id=$2`,
    [orgId, notificationId])).rows[0]);
  if (!row) return null;
  return vendorDispatchEmailTemplate({ kind: row.kind, dependency: row.dependency, locale: row.locale,
    link: row.kind === "cancelled" || !row.token ? null : vendorJobUrl(origin, row.token) });
}

const finishSql = "SELECT app.b039_dispatch_finish($1,$2,$3,$4)";
async function closedReason(e: Pending) {
  return (await svc(null, c => c.query<{ reason: string | null }>(
    "SELECT reason FROM app.b039_dispatch_events WHERE notification_id=$1 AND status<>'pending'", [e.notification_id]))).rows[0]?.reason ?? undefined;
}
const closeStaleSql = "SELECT app.b039_dispatch_close_stale($1,$2) AS state";

/**
 * B-039 worker: claims committed, due vendor dispatch events in creation order and sends each through the shared
 * B-033 dispatcher (reservation, owner token, same retry key, settle/release/unknown/expiry, deduplicated Email
 * fallback). Env OFF performs no query; any OFF gate performs no write. A reschedule/cancellation waits for the
 * announcement it follows; a cancellation of a never-announced job closes silently. A row whose processing throws
 * (including inside re-authorization) is backed off and never blocks later rows. Captured transports only.
 */
export async function runVendorDispatchPushes(orgId: string, deps: {
  transport: Pick<LineTransport, "push">; origin: string; resolveRecipient: DispatchRecipientResolver;
  env?: LineEnv; limit?: number; timeoutMs?: number;
}): Promise<DispatchResult[]> {
  const env = deps.env ?? process.env;
  if (!readLineConfig(env).platformEnabled) return [];
  const limit = Math.max(1, Math.min(deps.limit ?? 25, 100));
  const pending = await svc(null, async c => {
    if ((await c.query<{ ok: boolean }>("SELECT app.b039_dispatch_push_enabled($1) AS ok", [orgId])).rows[0]?.ok !== true) return [];
    return (await c.query<Pending>(`SELECT e.notification_id,e.claim_id,e.kind,e.job_id,e.ticket_id,e.vendor_contact_id,n.locale
      FROM app.b039_dispatch_events e JOIN public.notifications n ON n.id=e.notification_id AND n.org_id=e.org_id
      WHERE e.org_id=$1 AND e.status='pending' AND e.next_attempt_at<=clock_timestamp()
      ORDER BY e.created_at,e.notification_id LIMIT $2`, [orgId, limit])).rows;
  });
  const results: DispatchResult[] = [];
  for (const e of pending) {
    const result = (status: string, reason?: string) => results.push({ notificationId: e.notification_id, kind: e.kind, status, ...(reason ? { reason } : {}) });
    let authorizeThrew = false;
    try {
      const target = await svc(null, async c => {
        const channel = (await c.query<{ id: string | null }>("SELECT app.b033_selected_channel($1) AS id", [orgId])).rows[0]?.id ?? null;
        const dependency = (await c.query<{ status: DependencyStatus }>(`SELECT d.status FROM app.b039_dispatch_events e
          JOIN app.b039_dispatch_events d ON d.notification_id=e.depends_on WHERE e.notification_id=$1`, [e.notification_id])).rows[0]?.status ?? null;
        const link = channel ? (await c.query<{ id: string }>(`SELECT id FROM public.line_account_links WHERE org_id=$1 AND contact_id=$2
          AND line_channel_id=$3 AND persona='vendor' AND status='linked' AND unlinked_at IS NULL ORDER BY linked_at DESC,id LIMIT 1`,
          [orgId, e.vendor_contact_id, channel])).rows[0]?.id ?? null : null;
        const secret = e.kind === "cancelled" ? null : (await c.query<{ token: string }>(`SELECT s.token FROM repair_vendor_secrets s
          JOIN repair_vendor_jobs j ON j.id=s.job_id WHERE s.job_id=$1 AND j.org_id=$2 AND j.active AND j.revoked_at IS NULL
          AND j.expires_at>clock_timestamp()`, [e.job_id, orgId])).rows[0]?.token ?? null;
        // A claim already reserved/fallen back on another OA cannot be dispatched on the newly selected one
        // (B-033 rejects the claim scope); it takes the channel-independent replay path instead.
        const moved = channel ? (await c.query<{ moved: boolean }>(`SELECT EXISTS(
            SELECT 1 FROM app.b033_push_reservations WHERE claim_id=$1 AND line_channel_id<>$2
            UNION ALL SELECT 1 FROM app.b033_push_fallbacks WHERE claim_id=$1 AND line_channel_id<>$2) AS moved`,
          [e.claim_id, channel])).rows[0].moved : false;
        return { channel, moved, dependency, link, secret };
      });
      if (e.kind !== "assigned" && (!target.dependency || target.dependency === "pending")) { result("deferred"); continue; }
      if (e.kind === "cancelled" && !announced(target.dependency)) {
        // The vendor never received this job: nothing to cancel on LINE or by Email.
        await svc(null, c => c.query(finishSql, [e.notification_id, e.claim_id, "superseded", "never_announced"]));
        result("superseded", "never_announced"); continue;
      }
      // A reschedule whose previous announcement never went out is this vendor's first notice of the job.
      const copyKind = announcedKind(e.kind, target.dependency);
      const inner = authorizeEvent(orgId, e, target.secret ? hashVendorToken(target.secret) : null,
        e.kind === "assigned" ? null : announced(target.dependency));
      const authorize: LinePushAuthorize = async c => { try { return await inner(c); } catch (error) { authorizeThrew = true; throw error; } };
      if (!target.channel || target.moved) {
        const outcome = await svc(null, async c => {
          const verdict = await authorize(c);
          if (verdict === "stale") return (await c.query<{ state: string | null }>(closeStaleSql, [e.notification_id, e.claim_id])).rows[0]?.state ?? "skipped";
          if (verdict !== "ok") return verdict === "defer" ? "deferred" : "skipped";
          // Replays settled/fallback/uncertain attempts before any Email; only a never-started claim emails.
          return (await c.query<{ state: string | null }>("SELECT app.b039_dispatch_no_channel($1,$2) AS state", [e.notification_id, e.claim_id])).rows[0]?.state ?? "skipped";
        });
        if (outcome === "wait") await expireLinePushes(orgId, env); // B-033 expiry owns the single possible-duplicate Email
        if (outcome === "busy" || outcome === "wait") await svc(null, c => c.query("SELECT app.b039_dispatch_backoff($1,$2)", [e.notification_id, e.claim_id]));
        result(outcome, await closedReason(e)); continue;
      }
      const recipient = target.link ? await deps.resolveRecipient({ orgId, channelId: target.channel, linkId: target.link }).catch(() => null) : null;
      const link = target.secret ? vendorJobUrl(deps.origin, target.secret) : null;
      const outcome = await dispatchLinePush({
        orgId, notificationId: e.notification_id, claimId: e.claim_id, channelId: target.channel, persona: "vendor",
        to: recipient?.to ?? "", identityPepper: recipient?.identityPepper ?? "",
        messages: vendorDispatchMessages(copyKind, e.locale, link),
      }, deps.transport, env, { timeoutMs: deps.timeoutMs, authorize });
      if (outcome.status === "unknown" || outcome.status === "busy") {
        // Never re-poll a non-terminal claim without backoff; the same claim/retry key/reservation is reused when due.
        // When authority could not be established there was no LINE call and no Email.
        await svc(null, c => c.query("SELECT app.b039_dispatch_backoff($1,$2)", [e.notification_id, e.claim_id]));
        result(authorizeThrew ? "retry" : outcome.status); continue;
      }
      if (outcome.status === "superseded") {
        // Never just "superseded" when an earlier attempt may have reached LINE: see app.b039_dispatch_close_stale.
        const state = (await svc(null, c => c.query<{ state: string | null }>(closeStaleSql, [e.notification_id, e.claim_id]))).rows[0]?.state ?? null;
        if (state === "busy") await svc(null, c => c.query("SELECT app.b039_dispatch_backoff($1,$2)", [e.notification_id, e.claim_id]));
        result(state ?? "skipped", await closedReason(e)); continue;
      }
      const finish = outcome.status === "accepted" ? { status: "sent", reason: copyKind !== e.kind ? "announced_as_assigned" : null }
        : "emailClaim" in outcome && outcome.emailClaim ? { status: "fallback", reason: "reason" in outcome && outcome.reason ? outcome.reason : null }
        : null;
      if (finish) await svc(null, c => c.query(finishSql, [e.notification_id, e.claim_id, finish.status, finish.reason]));
      result(finish?.status ?? outcome.status, finish?.reason ?? ("reason" in outcome && outcome.reason ? outcome.reason : undefined));
    } catch (error) {
      const code = (error as { code?: unknown })?.code;
      console.error("b039_dispatch_retry_pending", { code: typeof code === "string" && /^[0-9A-Z]{5}$/.test(code) ? code : "unknown" });
      try { await svc(null, c => c.query("SELECT app.b039_dispatch_backoff($1,$2)", [e.notification_id, e.claim_id])); } catch { /* retried next run */ }
      result("retry");
    }
  }
  return results;
}
