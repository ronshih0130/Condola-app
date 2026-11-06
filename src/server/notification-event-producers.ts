import type { Client } from "pg";
import { makeT, type Locale } from "@/i18n";
import { handoverCopy } from "@/i18n/handover";
import { centerCopy } from "@/i18n/lanes/notification-center";
import { notificationEventCopy } from "@/i18n/lanes/notification-events";
import { ownerNetLedgerCopy } from "@/i18n/owner-net-ledger";
import { svc } from "./db";
import { moneyLabel } from "./format";
import { renderLocalReminder } from "./local-reminder-capture";

/**
 * B-028 package 2: durable notification events emitted inside the business
 * transaction that committed their source (flag `notification_events_v2`, OFF by
 * default). Callers pass only the committed source row; the service-only gateway
 * derives family/kind/version/offset and the intended recipients from rows of the
 * same organization, deduplicates on (source, version, recipient, offset), and
 * enqueues package-1 delivery attempts only when `notification_delivery_v2` is ON.
 *
 * OFF contract: the business transaction issues exactly one extra read-only
 * statement (tagged with NOTIFICATION_EVENTS_PROBE) and nothing else; every existing
 * statement and its order are unchanged and no row is written.
 * Renewal is deferred: there is no durable renewal operation on this branch.
 */
export type NotificationSourceKind =
  | "invitation" | "b010_source_event" | "payment" | "handover_version" | "statement_version"
  | "repair_estimate_version" | "repair_outbox" | "repair_decision";
export type NotificationFamily = "invite" | "bill" | "payment" | "handover" | "report" | "repair";
export type NotificationKind =
  | "invite_issued" | "rent_due" | "rent_overdue" | "rent_manual"
  | "payment_confirmed" | "payment_rejected" | "payment_reversed"
  | "handover_published" | "report_version_recorded"
  | "repair_approval_requested" | "repair_emergency_notice" | "repair_decision_recorded";

export const NOTIFICATION_EVENTS_PROBE = "/* b028:notification_events_v2 probe */";
const PROBE_SQL = `${NOTIFICATION_EVENTS_PROBE} SELECT EXISTS (SELECT 1 FROM public.organizations o
  JOIN public.platform_settings f ON f.key='notification_events_v2'
  WHERE o.id=$1 AND (o.feature_flags->'notification_events_v2'='true'::jsonb) IS TRUE
    AND (f.value->'enabled'='true'::jsonb) IS TRUE AND (jsonb_typeof(f.value->'allowed_org_ids')='array') IS TRUE
    AND (f.value->'allowed_org_ids' @> jsonb_build_array(o.id::text)) IS TRUE) AS enabled,
  current_user::text AS role, (current_user=session_user) AS owner`;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

let installed = true;
/** Test-only: uninstalled hooks issue no SQL at all, giving the pre-B-028 baseline. */
export function __setNotificationProducersInstalledForTests(value: boolean) { installed = value; }

/**
 * Emit one durable event for a committed source on the caller's transaction.
 * The gateway is EXECUTE-granted to service_role only; an authenticated or owner
 * connection switches to it for the single call and restores its role afterwards.
 */
export async function produceNotificationEvent(client: Client, orgId: string, kind: NotificationSourceKind, sourceId: string | null | undefined): Promise<string | null> {
  if (!installed || !sourceId || !UUID.test(orgId) || !UUID.test(sourceId)) return null;
  const probe = (await client.query<{ enabled: boolean; role: string; owner: boolean }>(PROBE_SQL, [orgId])).rows[0];
  if (!probe?.enabled) return null;
  const restore = probe.role === "service_role" ? null : probe.role === "authenticated" ? "SET LOCAL ROLE authenticated" : probe.owner ? "RESET ROLE" : undefined;
  // ON with an unexpected role is a caller defect: fail the transaction rather than drop the event.
  if (restore === undefined) throw new Error("Notification producer unavailable for this connection role");
  if (restore) await client.query("SET LOCAL ROLE service_role");
  const id = (await client.query<{ id: string | null }>("SELECT app.b028_produce_event($1,$2,$3)::text AS id", [orgId, kind, sourceId])).rows[0].id;
  // On error the transaction is aborted and rolls back with the business change.
  if (restore) await client.query(restore);
  return id;
}

export type NotificationMessageInput = {
  kind: NotificationKind;
  vars: Record<string, unknown>;
  locale: Locale;
  persona: "staff" | "tenant" | "owner";
  recipientName: string;
  firmName: string;
};
export type NotificationMessage = { subject: string; text: string };

const str = (value: unknown) => (typeof value === "string" || typeof value === "number" ? String(value) : "");

/** Pure template rendering; existing copy is reused wherever it exists. */
export function renderNotificationMessage(input: NotificationMessageInput): NotificationMessage {
  const { kind, vars, locale, recipientName: name, firmName: firm } = input;
  const words = notificationEventCopy(locale);
  const center = centerCopy(locale);
  const amount = (minor: unknown, currency: unknown) => moneyLabel(str(minor), str(currency), locale);
  switch (kind) {
    case "rent_due": case "rent_overdue": case "rent_manual": {
      const reminder = renderLocalReminder({ claim_id: "", claim_token: "", email: "", recipient_name: name, locale,
        due_date: str(vars.due_date), balance_minor: str(vars.balance_minor), currency: str(vars.currency), firm_name: firm,
        recipient_kind: input.persona === "staff" ? "staff" : "tenant" });
      return { subject: center.kinds[kind], text: reminder.text };
    }
    case "payment_confirmed": case "payment_rejected": case "payment_reversed":
      return { subject: center.kinds[kind], text: words.payment(name, firm, center.kinds[kind], amount(vars.amount_minor, vars.currency)) };
    case "invite_issued": {
      const t = makeT(locale);
      const lead = vars.invite_kind === "owner" ? t("i_owner_invite", { firm }) : `${t("i_invite_firm", { firm })}${locale === "en" ? "." : "。"}`;
      const expiry = t("i_invite_expiry", { d: str(vars.expires_on) });
      return { subject: vars.invite_kind === "owner" ? words.inviteSubjectOwner : words.inviteSubjectTenant, text: `${name}${locale === "en" ? ", " : "，"}${lead}${locale === "en" ? " " : ""}${expiry}${locale === "en" ? ". " : "。"}${words.inviteOpen}` };
    }
    case "handover_published": {
      const copy = handoverCopy(locale);
      return { subject: copy.title, text: words.handover(name, firm, vars.phase === "move_out" ? copy.out : copy.in, Number(vars.revision)) };
    }
    case "report_version_recorded": {
      const copy = ownerNetLedgerCopy(locale);
      return { subject: copy.title, text: words.report(name, firm, str(vars.period_start), str(vars.period_end), copy.version(Number(vars.version_no))) };
    }
    case "repair_approval_requested":
      return { subject: words.repair.title, text: words.approval(name, firm, amount(vars.amount_minor, vars.currency)) };
    case "repair_emergency_notice": {
      const copy = words.repair;
      const category = copy[str(vars.category)] ?? "";
      return { subject: copy.emergency, text: words.emergency(name, firm, locale === "en" ? category.toLowerCase() : category) };
    }
    case "repair_decision_recorded": {
      const copy = words.repair;
      return { subject: copy.title, text: words.decision(name, firm, Number(vars.version_no), copy[str(vars.decision)] ?? "") };
    }
  }
}

/** Service read of one recipient's template inputs (empty while OFF). Callers authorize first. */
export async function notificationMessageFor(orgId: string, eventId: string, recipientKey: string): Promise<NotificationMessage | null> {
  const row = await svc(null, async (client) => {
    await client.query("SELECT set_config('app.active_org_id',$1,true)", [orgId]);
    return (await client.query<{ kind: NotificationKind; vars: Record<string, unknown>; locale: Locale; persona: NotificationMessageInput["persona"]; recipient_name: string; firm_name: string }>(
      "SELECT * FROM app.b028_event_message($1,$2,$3)", [orgId, eventId, recipientKey])).rows[0] ?? null;
  });
  return row ? renderNotificationMessage({ kind: row.kind, vars: row.vars, locale: row.locale, persona: row.persona, recipientName: row.recipient_name, firmName: row.firm_name }) : null;
}
