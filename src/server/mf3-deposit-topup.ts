import { guardEffectiveSession } from "./b017-custom-role-governance";
import { brandV3ReadForOrg } from "./brand-v3";
import { svc } from "./db";
import { FlowError, logServerError } from "./errors";
import { assertPerm } from "./perms";
import { isUuid } from "./repair-rules";
import type { Session } from "./types";
import { TOPUP_NOTE_MAX, validTopupDate } from "../lib/deposit-topup";

/**
 * MF-3 / MGT-151-AC1…AC5 (MO-TOPUP, 租約 › {租客} › 退租結算). One admitted SQL snapshot per read and one
 * gateway call per write: app.mf3_topup_view / app.mf3_topup_record repeat the B-011 admission themselves
 * (env/live tuple, live session, role, `deposit_settlement` flag). brand_v3 gates the presentation.
 * Recording is pay.record (admin, manager, accountant); the tenant and the owner read the same version.
 * No payment method is taken or stored, and nothing is sent outside the app.
 */
export type TopupEntry = { id: string; amountMinor: string; receivedOn: string };
export type TopupView = {
  settlementId: string; leaseId: string; tenant: string | null; currency: string; minorUnit: number;
  depositMinor: string; deductionMinor: string; owedMinor: string; paidMinor: string;
  entries: TopupEntry[]; canRecord: boolean;
};
export type TopupRead = { state: "off" | "none" | "forbidden" | "unavailable" } | { state: "ready"; view: TopupView };
export type TopupInput = {
  leaseId: string; settlementId: string; requestId: string; amountMinor: string; receivedOn: string; note?: string | null;
};
export type TopupResult =
  | { ok: true; paidMinor: string; overMinor: string; replayed: boolean }
  | { ok: false; reason: "off" | "forbidden" | "invalid" | "conflict" | "failed" };
type Deps = { v3?: typeof brandV3ReadForOrg; transaction?: typeof svc };
type Kind = Session["kind"];

const MAX_MINOR = BigInt("1000000000000000");
const day = /^\d{4}-\d{2}-\d{2}$/;
const str = (value: unknown): value is string => typeof value === "string";
const uuid = (value: unknown): value is string => str(value) && isUuid(value);
const minor = (value: unknown): value is string => str(value) && /^[0-9]{1,16}$/.test(value);

/** svc rethrows DB errors through mapDbError, which keeps the SQLSTATE in `cause.code`. */
function sqlDenied(error: unknown): boolean {
  const e = error as { code?: unknown; cause?: { code?: unknown } } | null;
  return e?.code === "42501" || e?.cause?.code === "42501";
}
const denied = (error: unknown) => sqlDenied(error) || (error instanceof FlowError && error.key === "errors.forbidden");

export function parseTopupView(value: unknown, leaseId: string, kind: Kind): TopupView | null {
  if (value === null || value === undefined) return null;
  const v = value as Record<string, unknown>;
  if (!v || typeof v !== "object" || v.leaseId !== leaseId || !uuid(v.settlementId) || !(v.tenant === null || str(v.tenant))
    || !str(v.currency) || !/^[A-Z]{3}$/.test(v.currency) || !Number.isInteger(v.minorUnit) || (v.minorUnit as number) < 0
    || (v.minorUnit as number) > 4 || ![v.depositMinor, v.deductionMinor, v.owedMinor, v.paidMinor].every(minor)
    || BigInt(v.owedMinor as string) <= BigInt(0) || v.canRecord !== (kind === "staff") || (kind !== "staff" && v.tenant !== null) || !Array.isArray(v.entries))
    throw new Error("Invalid top-up view");
  let sum = BigInt(0);
  for (const row of v.entries as Record<string, unknown>[]) {
    if (!row || !uuid(row.id) || !minor(row.amountMinor) || !str(row.receivedOn) || !day.test(row.receivedOn)
      || Object.keys(row).length !== 3) throw new Error("Invalid top-up entry");
    sum += BigInt(row.amountMinor);
  }
  // MGT-151-AC2: 已補 is the sum of the listed entries.
  if (sum.toString() !== v.paidMinor) throw new Error("Top-up sum mismatch");
  return v as TopupView;
}

async function admit(input: Session, deps: Deps): Promise<Session | { state: "off" | "forbidden" }> {
  if (!(await (deps.v3 ?? brandV3ReadForOrg)(input.orgId))) return { state: "off" };
  // B-017: the effective session first (one literal guard for all three apps); staff then need pay.record.
  const session = await guardEffectiveSession(input, null);
  if (session.kind === "staff") assertPerm(session, "pay.record");
  if (!uuid(session.orgId) || !uuid(session.liveOrgId) || !uuid(session.sessionId)
    || !["live", "sandbox"].includes(session.environment)) return { state: "forbidden" };
  return session;
}

/** MGT-151-AC1/AC2: the same version for staff, the tenant and the owner of this lease. */
export async function depositTopupView(input: Session, leaseId: string, deps: Deps = {}): Promise<TopupRead> {
  try {
    const session = await admit(input, deps);
    if ("state" in session) return session;
    if (!uuid(leaseId)) return { state: "forbidden" };
    const view = await (deps.transaction ?? svc)(session.userId, async client => {
      await client.query("SET LOCAL statement_timeout = '2s'");
      await client.query("SET LOCAL lock_timeout = '1s'");
      await client.query("SELECT set_config('app.active_org_id',$1,true),set_config('app.env',$2,true)", [session.orgId, session.environment]);
      const row = (await client.query<{ result: unknown }>(
        "SELECT app.mf3_topup_view($1::uuid,$2::uuid,$3::text,$4::uuid,$5::text,$6::uuid) AS result",
        [session.orgId, session.liveOrgId, session.environment, session.sessionId, session.kind, leaseId],
      )).rows[0];
      if (!row) throw new Error("Missing top-up snapshot");
      return parseTopupView(row.result, leaseId, session.kind);
    }, { isolation: "repeatable read" });
    return view ? { state: "ready", view } : { state: "none" };
  } catch (error) {
    if (denied(error)) return { state: "forbidden" };
    logServerError("mf3_topup_view", error);
    return { state: "unavailable" };
  }
}

/** MGT-151-AC1/AC3/AC4/AC5. Over 應補 still saves (the sheet asks first); a retry with the same requestId replays. */
export async function recordDepositTopup(input: Session, form: TopupInput, deps: Deps = {}): Promise<TopupResult> {
  try {
    const session = await admit(input, deps);
    if ("state" in session) return { ok: false, reason: session.state };
    if (session.kind !== "staff") return { ok: false, reason: "forbidden" };
    const note = typeof form?.note === "string" ? form.note.trim() : "";
    if (!form || !uuid(form.leaseId) || !uuid(form.settlementId) || !uuid(form.requestId)
      || !str(form.amountMinor) || !/^[1-9][0-9]{0,15}$/.test(form.amountMinor) || BigInt(form.amountMinor) > MAX_MINOR
      || !str(form.receivedOn) || !validTopupDate(form.receivedOn) || note.length > TOPUP_NOTE_MAX
      || (form.note !== undefined && form.note !== null && typeof form.note !== "string")) return { ok: false, reason: "invalid" };
    const result = await (deps.transaction ?? svc)(session.userId, async client => {
      await client.query("SET LOCAL statement_timeout = '5s'");
      await client.query("SET LOCAL lock_timeout = '2s'");
      await client.query("SELECT set_config('app.active_org_id',$1,true),set_config('app.env',$2,true)", [session.orgId, session.environment]);
      return (await client.query<{ result: Record<string, unknown> | null }>(
        `SELECT app.mf3_topup_record($1::uuid,$2::uuid,$3::text,$4::uuid,$5::uuid,$6::uuid,$7::uuid,$8::bigint,$9::date,$10::text) AS result`,
        [session.orgId, session.liveOrgId, session.environment, session.sessionId, form.requestId,
          form.leaseId, form.settlementId, form.amountMinor, form.receivedOn, note || null],
      )).rows[0]?.result ?? null;
    });
    const status = result?.status;
    if (status === "recorded" && minor(result?.paidMinor) && minor(result?.overMinor) && typeof result?.replayed === "boolean")
      return { ok: true, paidMinor: result.paidMinor, overMinor: result.overMinor, replayed: result.replayed };
    if (status === "disabled") return { ok: false, reason: "off" };
    if (status === "invalid") return { ok: false, reason: "invalid" };
    if (status === "conflict") return { ok: false, reason: "conflict" };
    if (status !== "unavailable") logServerError("mf3_topup_record", new Error(`Unexpected top-up result ${String(status)}`));
    return { ok: false, reason: "failed" };
  } catch (error) {
    if (denied(error)) return { ok: false, reason: "forbidden" };
    logServerError("mf3_topup_record", error);
    return { ok: false, reason: "failed" };
  }
}
