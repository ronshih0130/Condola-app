import { createHash } from "node:crypto";
import { guardEffectiveSession } from "./b017-custom-role-governance";
import { brandV3ReadForOrg } from "./brand-v3";
import { svc } from "./db";
import { FlowError, logServerError } from "./errors";
import { assertPerm } from "./perms";
import { isUuid } from "./repair-rules";
import type { Session } from "./types";

/**
 * B-091 OWN-RULE (OWN-34-AC3/AC4, OWN-36, MGT-130-AC2 amended): the owner's renewal rule, its activity log and
 * the staff read of each change. One gateway call per read or write; each gateway repeats its own admission
 * (env/live tuple, live session, owner_rules flag, PR-015 current owner / staff role). brand_v3 gates the
 * presentation. Screens are B-094; the repair limit stays the B-021 policy. Nothing is sent outside the app.
 */
import { RENEWAL_RULES, type RenewalRule } from "./b091-owner-rules-values";
export { DEFAULT_RENEWAL_RULE, RENEWAL_RULES, type RenewalRule } from "./b091-owner-rules-values";
export type OwnerRule = { rule: RenewalRule; revision: number; changedAt: string | null };
export type OwnerRuleView = { state: "off" | "forbidden" | "unavailable" } | ({ state: "ready" } & OwnerRule);
export type SetOwnerRuleInput = { requestId: string; rule: string; expectedRevision: number };
export type SetOwnerRuleResult =
  | { ok: true; rule: RenewalRule; revision: number; changed: boolean; replayed: boolean }
  | { ok: false; reason: "stale"; rule: RenewalRule; revision: number }
  | { ok: false; reason: "off" | "forbidden" | "invalid" | "conflict" | "failed" };
export type RuleChange = { seq: string; ownerContactId: string; ownerName: string; rule: RenewalRule; previousRule: RenewalRule; revision: number; changedAt: string };
export type StaffRuleChanges = { state: "off" | "forbidden" | "unavailable" }
  | { state: "ready"; owner: ({ ownerContactId: string; name: string } & OwnerRule) | null; changes: RuleChange[]; next: string | null };
type Deps = { v3?: typeof brandV3ReadForOrg; transaction?: typeof svc };

const str = (v: unknown): v is string => typeof v === "string";
const uuid = (v: unknown): v is string => str(v) && isUuid(v);
const rule = (v: unknown): v is RenewalRule => RENEWAL_RULES.includes(v as RenewalRule);
const instant = (v: unknown) => str(v) && Number.isFinite(Date.parse(v));
const revision = (v: unknown): v is number => Number.isInteger(v) && (v as number) >= 0;
const BIGINT_MAX = BigInt("9223372036854775807");
const seq = (v: unknown): v is string => str(v) && /^[1-9][0-9]{0,18}$/.test(v) && BigInt(v) <= BIGINT_MAX;

function sqlDenied(error: unknown): boolean {
  const e = error as { code?: unknown; cause?: { code?: unknown } } | null;
  return e?.code === "42501" || e?.cause?.code === "42501";
}
const denied = (error: unknown) => sqlDenied(error) || (error instanceof FlowError && error.key === "errors.forbidden");
const scoped = (s: Session) => uuid(s.orgId) && uuid(s.liveOrgId) && uuid(s.sessionId) && ["live", "sandbox"].includes(s.environment);

async function admitOwner(input: Session, deps: Deps): Promise<Session | { state: "off" | "forbidden" }> {
  if (!(await (deps.v3 ?? brandV3ReadForOrg)(input.orgId))) return { state: "off" };
  const session = await guardEffectiveSession(input, null);
  if (session.kind !== "owner" || !scoped(session)) return { state: "forbidden" };
  return session;
}
async function admitStaff(input: Session, deps: Deps): Promise<Session | { state: "off" | "forbidden" }> {
  if (!(await (deps.v3 ?? brandV3ReadForOrg)(input.orgId))) return { state: "off" };
  const session = await guardEffectiveSession(input, "props.view");
  assertPerm(session, "props.view");
  const native = session.customRole?.nativeRole ?? session.role;
  if (session.kind !== "staff" || !native || !["admin", "manager", "accountant"].includes(native) || !scoped(session)) return { state: "forbidden" };
  return session;
}
const PIN = "SELECT set_config('app.active_org_id',$1,true),set_config('app.env',$2,true)";

export function parseOwnerRule(value: unknown): OwnerRule | null {
  if (value === null || value === undefined) return null;
  const v = value as Record<string, unknown>;
  if (!v || !rule(v.rule) || !revision(v.revision) || !(v.changedAt === null || instant(v.changedAt)) || (v.revision === 0) !== (v.changedAt === null))
    throw new Error("Invalid owner rule");
  return { rule: v.rule, revision: v.revision, changedAt: v.changedAt as string | null };
}

/** OWN-34-AC3: the owner's own renewal rule (the default when never set). */
export async function ownerRuleView(input: Session, deps: Deps = {}): Promise<OwnerRuleView> {
  try {
    const session = await admitOwner(input, deps);
    if ("state" in session) return session;
    const view = await (deps.transaction ?? svc)(session.userId, async client => {
      await client.query("SET LOCAL statement_timeout = '2s'");
      await client.query("SET LOCAL lock_timeout = '1s'");
      await client.query(PIN, [session.orgId, session.environment]);
      const row = (await client.query<{ result: unknown }>("SELECT app.b091_owner_rule_view($1::uuid,$2::uuid,$3::text,$4::uuid) AS result",
        [session.orgId, session.liveOrgId, session.environment, session.sessionId])).rows[0];
      if (!row) throw new Error("Missing owner rule snapshot");
      return parseOwnerRule(row.result);
    }, { isolation: "repeatable read" });
    return view ? { state: "ready", ...view } : { state: "off" };
  } catch (error) {
    if (denied(error)) return { state: "forbidden" };
    logServerError("b091_owner_rule_view", error);
    return { state: "unavailable" };
  }
}

/** One raw form value, typed, so that values JSON would merge (NaN/null, -0/0, 1/"1", undefined/null) stay distinct. */
function canonicalValue(value: unknown): unknown[] {
  if (value === undefined) return ["undefined"];
  if (value === null) return ["null"];
  if (typeof value === "number") return ["number", Object.is(value, -0) ? "-0" : String(value)];
  if (typeof value === "string" || typeof value === "boolean" || typeof value === "bigint") return [typeof value, String(value)];
  try {
    const sorted = (v: unknown): unknown => Array.isArray(v) ? v.map(sorted)
      : v && typeof v === "object" ? Object.fromEntries(Object.keys(v).sort().map(k => [k, sorted((v as Record<string, unknown>)[k])])) : v;
    return ["json", JSON.stringify(sorted(value)) ?? "undefined"];
  } catch { return ["unserialisable", Object.prototype.toString.call(value)]; }
}
/** sha256 (hex) of the canonical JSON of the RAW payload the request id is reserved with (rule and expected revision). */
export function ownerRulePayloadFingerprint(form: { rule?: unknown; expectedRevision?: unknown }): string {
  return createHash("sha256").update(JSON.stringify({ expectedRevision: canonicalValue(form.expectedRevision), rule: canonicalValue(form.rule) })).digest("hex");
}

/** OWN-34-AC4: the owner changes the renewal rule; written to the activity log; a save failure keeps the old rule. */
export async function setOwnerRule(input: Session, form: SetOwnerRuleInput, deps: Deps = {}): Promise<SetOwnerRuleResult> {
  try {
    const session = await admitOwner(input, deps);
    if ("state" in session) return { ok: false, reason: session.state };
    // Only an unusable request id is refused here. Any other invalid payload goes to the gateway, which reserves the
    // id with outcome invalid, so a retry of that id with corrected input is a conflict, never a second save. The
    // normalised values below are lossy (every bad revision is NULL), so the id is bound to a fingerprint of the RAW
    // payload too: the same id with any other payload, valid or not, is a conflict.
    if (!form || !uuid(form.requestId)) return { ok: false, reason: "invalid" };
    const requested = typeof form.rule === "string" && form.rule.length <= 64 ? form.rule : null;
    const expected = revision(form.expectedRevision) && form.expectedRevision <= 2147483647 ? form.expectedRevision : null;
    const fingerprint = ownerRulePayloadFingerprint(form);
    // READ COMMITTED: the gateway waits on row locks first and re-admits afterwards in a fresh snapshot.
    const result = await (deps.transaction ?? svc)(session.userId, async client => {
      await client.query("SET LOCAL statement_timeout = '5s'");
      await client.query("SET LOCAL lock_timeout = '2s'");
      await client.query(PIN, [session.orgId, session.environment]);
      return (await client.query<{ result: Record<string, unknown> | null }>(
        "SELECT app.b091_owner_rule_set($1::uuid,$2::uuid,$3::text,$4::uuid,$5::uuid,$6::text,$7::integer,$8::text) AS result",
        [session.orgId, session.liveOrgId, session.environment, session.sessionId, form.requestId, requested, expected, fingerprint])).rows[0]?.result ?? null;
    }, { isolation: "read committed" });
    const status = result?.status, replayed = result?.replayed === true;
    if ((status === "saved" || status === "unchanged") && rule(result?.rule) && revision(result?.revision) && typeof result?.replayed === "boolean")
      return { ok: true, rule: result.rule, revision: result.revision, changed: status === "saved", replayed };
    if (status === "stale" && rule(result?.rule) && revision(result?.revision)) return { ok: false, reason: "stale", rule: result.rule, revision: result.revision };
    if (status === "disabled") return { ok: false, reason: "off" };
    if (status === "invalid") return { ok: false, reason: "invalid" };
    if (status === "conflict") return { ok: false, reason: "conflict" };
    logServerError("b091_owner_rule_set", new Error(`Unexpected owner rule result ${String(status)}`));
    return { ok: false, reason: "failed" };
  } catch (error) {
    if (denied(error)) return { ok: false, reason: "forbidden" };
    logServerError("b091_owner_rule_set", error);
    return { ok: false, reason: "failed" };
  }
}

export function parseStaffRuleChanges(value: unknown): Omit<Extract<StaffRuleChanges, { state: "ready" }>, "state"> | null {
  if (value === null || value === undefined) return null;
  const v = value as Record<string, unknown>;
  if (!v || !Array.isArray(v.changes) || !(v.next === null || seq(v.next))) throw new Error("Invalid rule changes");
  const o = v.owner as Record<string, unknown> | null;
  if (o !== null && (!o || !uuid(o.ownerContactId) || !str(o.name) || !parseOwnerRule(o))) throw new Error("Invalid rule owner");
  for (const c of v.changes as Record<string, unknown>[])
    if (!c || !seq(c.seq) || !uuid(c.ownerContactId) || !str(c.ownerName) || !rule(c.rule) || !rule(c.previousRule) || c.rule === c.previousRule
      || !Number.isInteger(c.revision) || (c.revision as number) < 1 || !instant(c.changedAt)) throw new Error("Invalid rule change");
  return v as Omit<Extract<StaffRuleChanges, { state: "ready" }>, "state">;
}

/** OWN-34-AC4 staff side: an owner's current rule and the change log, newest first (feeds the in-app notice). */
export async function staffRuleChanges(input: Session, options: { ownerContactId?: string | null; after?: string | null } = {}, deps: Deps = {}): Promise<StaffRuleChanges> {
  try {
    const session = await admitStaff(input, deps);
    if ("state" in session) return session;
    const owner = options.ownerContactId ?? null, after = options.after ?? null;
    if ((owner !== null && !uuid(owner)) || (after !== null && !seq(after))) return { state: "forbidden" };
    const page = await (deps.transaction ?? svc)(session.userId, async client => {
      await client.query("SET LOCAL statement_timeout = '2s'");
      await client.query("SET LOCAL lock_timeout = '1s'");
      await client.query(PIN, [session.orgId, session.environment]);
      const row = (await client.query<{ result: unknown }>(
        "SELECT app.b091_staff_rule_changes($1::uuid,$2::uuid,$3::text,$4::uuid,$5::uuid,$6::bigint,$7::integer) AS result",
        [session.orgId, session.liveOrgId, session.environment, session.sessionId, owner, after, 20])).rows[0];
      if (!row) throw new Error("Missing rule changes snapshot");
      return parseStaffRuleChanges(row.result);
    }, { isolation: "repeatable read" });
    return page ? { state: "ready", ...page } : { state: "off" };
  } catch (error) {
    if (denied(error)) return { state: "forbidden" };
    logServerError("b091_staff_rule_changes", error);
    return { state: "unavailable" };
  }
}
