import { svc } from "../db";
import { lineRentPushStatusLabel, lineRentPushText, type RentPushKind } from "@/i18n/line-rent-push";
import type { Locale } from "@/i18n";
import { readLineConfig, type LineEnv } from "./config";
import { dispatchLinePush } from "./quota";
import type { LineTransport } from "./transport";

/** Transient trusted service input. The address is hash-checked by B-033 and never stored or logged. */
export type LineRecipientResolver = (input: { orgId: string; channelId: string; linkId: string; contactId: string })
 => Promise<{ to: string; identityPepper: string } | null>;
type Prepared = { state: string; reason: string | null; notification_id: string | null; channel_id: string | null;
 link_id: string | null; recipient_contact_id: string | null; kind: RentPushKind | null; locale: string | null; company: string | null;
 amount_minor: string | null; currency: string | null; due_date: string | null; liff_id: string | null; line_reason: string | null };
export type RentPushResult = { claimId: string; outcome: "sent" | "fallback" | "suppressed" | "retry" | "busy" | "disabled" | "unavailable"; reason?: string };

const ZERO = BigInt(0), HALF = BigInt(50), HUNDRED = BigInt(100);
/** Exact minor-unit arithmetic with BigInt only (no floating point). */
export function rentPushAmount(minor: string | null, currency: string | null, locale: Locale) {
 const raw = /^-?[0-9]{1,30}$/.test(minor ?? "") ? BigInt(minor!) : ZERO;
 const value = raw < ZERO ? ZERO : raw;
 const code = (currency ?? "TWD").trim().toUpperCase() || "TWD";
 const group = new Intl.NumberFormat(locale === "en" ? "en-US" : "zh-Hant-TW", { maximumFractionDigits: 0 });
 // TWD is shown in whole dollars, rounding half up on the minor unit.
 if (code === "TWD") return `NT$${group.format((value + HALF) / HUNDRED)}`;
 return `${code} ${group.format(value / HUNDRED)}.${(value % HUNDRED).toString().padStart(2, "0")}`;
}
function date(iso: string | null, locale: Locale) {
 if (!iso) return null;
 const [y, m, d] = iso.slice(0, 10).split("-").map(Number);
 return locale === "en" ? `${iso.slice(0, 10)}` : `${y}年${m}月${d}日`;
}
/** LIFF deep link only: no invite/flow/session token, contact or claim id. /t/liff re-authenticates
 * and the tenant portal rechecks bill/lease permission after login. */
export function rentPushLiffUrl(liffId: string, orgId: string) {
 return `https://liff.line.me/${encodeURIComponent(liffId)}?org=${encodeURIComponent(orgId)}`;
}
export function rentPushMessage(p: Pick<Prepared, "kind" | "locale" | "company" | "amount_minor" | "currency" | "due_date" | "liff_id">, orgId: string) {
 const locale: Locale = p.locale === "en" ? "en" : "zh-TW";
 return lineRentPushText(p.kind!, locale, { company: p.company ?? "", amount: rentPushAmount(p.amount_minor, p.currency, locale),
  dueDate: date(p.due_date, locale), url: rentPushLiffUrl(p.liff_id ?? "", orgId) });
}

function limitOf(value: number | undefined) {
 return Number.isSafeInteger(value) && value! >= 1 && value! <= 200 ? value! : 200;
}
/** Claims committed B-010 events. Environment OFF performs no database access at all. */
export async function claimRentPushes(at: Date, env: LineEnv = process.env, options: { limit?: number } = {}) {
 if (!readLineConfig(env).platformEnabled || !Number.isFinite(at.getTime())) return 0;
 const limit = limitOf(options.limit);
 // Events that produced no claim are marked evaluated, so discovery pages past them.
 const pending = await svc(null, async c => (await c.query<{ org_id: string; event_id: string }>(
  "SELECT org_id::text,event_id::text FROM app.b037_pending($1,$2)", [at.toISOString(), limit])).rows);
 let claimed = 0;
 for (const item of pending) {
  try {
   claimed += await svc(null, async c => (await c.query("SELECT * FROM app.b037_claim($1,$2,$3)",
    [item.org_id, item.event_id, at.toISOString()])).rowCount ?? 0);
  } catch { /* lock contention or a concurrent claimer: the next run retries */ }
 }
 return claimed;
}

async function terminal(orgId: string, claimId: string) {
 return svc(null, async c => (await c.query<{ state: string }>("SELECT app.b037_mark($1,$2) AS state", [orgId, claimId])).rows[0].state);
}

/** Dispatches one claim. Reminder and recipient eligibility are rechecked first. */
export async function dispatchRentPush(orgId: string, claimId: string, at: Date, transport: Pick<LineTransport, "push">,
 resolveRecipient: LineRecipientResolver, env: LineEnv = process.env, options: { timeoutMs?: number } = {}): Promise<RentPushResult> {
 if (!readLineConfig(env).platformEnabled) return { claimId, outcome: "disabled" };
 const p = await svc(null, async c => (await c.query<Prepared>("SELECT * FROM app.b037_prepare($1,$2,$3)",
  [orgId, claimId, at.toISOString()])).rows[0]);
 if (!p || p.state === "disabled") return { claimId, outcome: "disabled" };
 if (p.state === "suppressed") return { claimId, outcome: "suppressed", reason: p.reason ?? undefined };
 if (p.state === "sent") return { claimId, outcome: "sent" };
 if (p.state === "fallback") return { claimId, outcome: "fallback", reason: p.reason ?? undefined };
 if (!p.channel_id || !p.notification_id) return { claimId, outcome: "unavailable" };
 if (p.line_reason) {
  // Serialized, deduplicated fallback with the precise recipient reason. An existing B-010 Email
  // claim for this event/recipient stays the only Email; otherwise one B-028 fallback is queued.
  await svc(null, c => c.query("SELECT * FROM app.b037_push_fallback($1,$2,$3,$4,$5)",
   [p.channel_id, claimId, orgId, p.notification_id, p.line_reason]));
 } else {
  const address = p.link_id && p.recipient_contact_id
   ? await resolveRecipient({ orgId, channelId: p.channel_id, linkId: p.link_id, contactId: p.recipient_contact_id }).catch(() => null)
   : null;
  const result = await dispatchLinePush({ orgId, notificationId: p.notification_id, claimId, channelId: p.channel_id, persona: "tenant",
   to: address?.to ?? "", identityPepper: address?.identityPepper ?? "", messages: [{ type: "text", text: rentPushMessage(p, orgId) }] },
  transport, env, { ...options, fallbackGateway: "b037" });
  if (result.status === "busy") return { claimId, outcome: "busy" };
  if (result.status === "disabled" || result.status === "fallback_unavailable") return { claimId, outcome: "disabled" };
 }
 const state = await terminal(orgId, claimId);
 if (state === "sent") return { claimId, outcome: "sent" };
 if (state === "fallback") {
  const reason = await svc(null, async c => (await c.query<{ reason: string }>(
   "SELECT error AS reason FROM public.deliveries WHERE org_id=$1 AND b033_claim_id=$2 AND channel='line'", [orgId, claimId])).rows[0]?.reason);
  return { claimId, outcome: "fallback", reason };
 }
 if (state === "disabled") return { claimId, outcome: "disabled" };
 if (state === "suppressed") return { claimId, outcome: "suppressed" };
 // Timeout/unknown: the claim stays claimed; the next run reuses the claim id, retry key and reservation.
 return { claimId, outcome: "retry" };
}

/** Local worker entry: claim committed events, then dispatch open claims of enabled orgs. */
export async function runLineRentPushes(at: Date, transport: Pick<LineTransport, "push">, resolveRecipient: LineRecipientResolver,
 env: LineEnv = process.env, options: { timeoutMs?: number; limit?: number } = {}) {
 if (!readLineConfig(env).platformEnabled || !Number.isFinite(at.getTime())) return { claimed: 0, results: [] as RentPushResult[] };
 const claimed = await claimRentPushes(at, env, { limit: options.limit });
 const open = await svc(null, async c => (await c.query<{ org_id: string; claim_id: string }>(
  "SELECT org_id::text,claim_id::text FROM app.b037_open($1,$2)", [at.toISOString(), limitOf(options.limit)])).rows);
 const results: RentPushResult[] = [];
 for (const item of open) {
  try { results.push(await dispatchRentPush(item.org_id, item.claim_id, at, transport, resolveRecipient, env, { timeoutMs: options.timeoutMs })); }
  // Never log provider addresses or message text; the durable claim is retried next run.
  catch { console.error("b037_dispatch_retry_pending"); results.push({ claimId: item.claim_id, outcome: "retry" }); }
 }
 return { claimed, results };
}

/** Staff/tenant-facing status. Provider acceptance is "sent" (送出); never delivered or read. */
export async function lineRentPushStatus(orgId: string, notificationId: string, locale: Locale = "zh-TW") {
 const rows = await svc(null, async c => (await c.query<{ channel: string; status: string; error: string | null }>(
  `SELECT channel::text,status::text,error FROM public.deliveries WHERE org_id=$1 AND notification_id=$2 AND b033_claim_id IS NOT NULL`,
  [orgId, notificationId])).rows);
 const line = rows.find(r => r.channel === "line"), email = rows.find(r => r.channel === "email");
 const cancelled = (await svc(null, async c => (await c.query<{ status: string }>(
  "SELECT status::text FROM public.notifications WHERE org_id=$1 AND id=$2", [orgId, notificationId])).rows[0]?.status)) === "cancelled";
 const fellBack = !!email || line?.status === "skipped" || (line?.status === "failed" && line.error !== "line_unknown_suppressed");
 const status = line?.status === "sent" ? "sent" as const : cancelled ? "suppressed" as const : fellBack ? "email_fallback" as const : "queued" as const;
 const reason = email?.error ?? line?.error;
 return { status, label: lineRentPushStatusLabel(status, locale), ...(status === "email_fallback" && reason ? { reason } : {}) };
}
