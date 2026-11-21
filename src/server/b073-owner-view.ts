import { guardEffectiveSession, requireEffectivePerm } from "./b017-custom-role-governance";
import { writeAudit } from "./audit";
import { brandV3EnabledForOrg } from "./brand-v3";
import { FlowError, logServerError } from "./errors";
import { requireOrgScope } from "./org-guard";
import { assertPerm } from "./perms";
import { privacyFromSettings, type OwnerPrivacy } from "./privacy";
import type { Session } from "./types";

/**
 * B-073 / R5-OWNVIEW (設定 › 規則與資料 › 屋主看得到什麼, MGT-138). The same company-wide owner-privacy setting as
 * today's `ownerPrivacy` / `setOwnerPrivacy` (organizations.settings show_tenant_name default true,
 * show_tenant_phone default false), admin only (`settings.edit`). Nothing is sent to owners (MGT-138-AC2):
 * a save writes only the changed key and the existing `owner_privacy` audit row (both-key state), nothing else.
 */
export type OwnerViewField = keyof OwnerPrivacy;
export const OWNER_VIEW_FIELDS: readonly OwnerViewField[] = ["showName", "showPhone"];
export type OwnerViewCompany = { name: string; taxId: string | null };
export type OwnerViewRead =
  | { state: "forbidden" | "unavailable" }
  | { state: "ready"; privacy: OwnerPrivacy; company: OwnerViewCompany };
export type OwnerViewSaveInput = { field: OwnerViewField; value: boolean };
/** POST /api/owner-view answers this as its HTTP status. 404 = brand_v3 OFF; 403 = not allowed; 400 = bad input. */
export type OwnerViewSaveResult = { ok: true; privacy: OwnerPrivacy } | { ok: false; status: 400 | 403 | 404 | 500 };

type Row = { settings: unknown; name: string | null; tax_id: string | null };
async function readOrganization(orgId: string): Promise<Row | undefined> {
  const { query } = await import("./db");
  return (await query<Row>("SELECT settings, name, tax_id FROM organizations WHERE id = $1", [orgId])).rows[0];
}
/** The settings key each switch owns (closed set; never built from input). */
const SETTINGS_KEY: Record<OwnerViewField, string> = { showName: "show_tenant_name", showPhone: "show_tenant_phone" };

type AuditWriter = (client: import("pg").Client, session: Session, privacy: OwnerPrivacy) => Promise<void>;
/**
 * The same `owner_privacy` audit row `setOwnerPrivacy` writes ({ showName, showPhone }), inside the caller's
 * transaction. `authenticated` has no INSERT on audit_log, so the insert runs as service_role for that one
 * statement and the role returns to authenticated (the b109b asService / requireEffectivePerm pattern).
 */
const auditOwnerView: AuditWriter = async (client, session, privacy) => {
  await client.query("SET LOCAL ROLE service_role");
  await writeAudit(session.orgId, session.userId, "owner_privacy", { showName: privacy.showName, showPhone: privacy.showPhone }, client);
  // Fixed identifier, never derived from request data; tx() runs fn as authenticated.
  await client.query("SET LOCAL ROLE authenticated");
};

/**
 * One atomic statement updates ONLY the changed key (no read-then-write, so the other key is never rewritten
 * from a stale read), under the same settings.edit guard and tx helper as `setOwnerPrivacy`. The audit row is
 * written in the same transaction from the resulting both-key state, so a failed audit rolls the change back.
 * `setOwnerPrivacy` itself is unchanged and still serves flag OFF (/m/roles form).
 */
async function writeOwnerViewKey(session: Session, field: OwnerViewField, value: boolean, audit: AuditWriter = auditOwnerView): Promise<OwnerPrivacy> {
  const { tx } = await import("./db");
  return tx(session.userId, async (client) => {
    await requireEffectivePerm(client, session, "settings.edit");
    const { rows } = await client.query<{ settings: unknown }>(
      `UPDATE organizations
          SET settings = jsonb_set(coalesce(settings, '{}'::jsonb), $2::text[], to_jsonb($3::boolean), true)
        WHERE id = $1
    RETURNING settings`,
      [session.orgId, [SETTINGS_KEY[field]], value],
    );
    if (!rows[0]) throw new Error("organization not found");
    const privacy = privacyFromSettings(rows[0].settings);
    await audit(client, session, privacy);
    return privacy;
  }, requireOrgScope(session));
}
type Deps = { read?: typeof readOrganization; write?: typeof writeOwnerViewKey; audit?: AuditWriter; v3?: (orgId: string) => Promise<boolean> };
const forbidden = (error: unknown) => (error instanceof FlowError && error.key === "errors.forbidden")
  || ((error as { code?: string } | null)?.code ?? (error as { cause?: { code?: string } } | null)?.cause?.code) === "42501";

/** Shared pre-body permission check for the company settings switches. */
export async function authorizeSettingsEdit(session: Session): Promise<Session | null> {
  try {
    session = await guardEffectiveSession(session, "settings.edit");
    assertPerm(session, "settings.edit");
    return session;
  } catch (error) {
    if (forbidden(error)) return null;
    throw error;
  }
}

/**
 * The 統編 comes from `organizations.tax_id` (schema column; the app has no editor for it yet), shown only when
 * it is a non-empty value. The company name is `organizations.name`.
 */
export async function ownerViewRead(session: Session, deps: Deps = {}): Promise<OwnerViewRead> {
  try {
    session = await guardEffectiveSession(session, "settings.edit");
    assertPerm(session, "settings.edit");
    const row = await (deps.read ?? readOrganization)(session.orgId);
    if (!row) return { state: "unavailable" };
    const taxId = typeof row.tax_id === "string" && row.tax_id.trim() !== "" ? row.tax_id.trim() : null;
    return { state: "ready", privacy: privacyFromSettings(row.settings ?? null), company: { name: (row.name ?? "").trim(), taxId } };
  } catch (error) {
    if (forbidden(error)) return { state: "forbidden" };
    logServerError("b073_owner_view_read", error);
    return { state: "unavailable" };
  }
}

/** One switch per save: only its key is written (see writeOwnerViewKey). */
export async function saveOwnerView(session: Session, input: unknown, deps: Deps = {}): Promise<OwnerViewSaveResult> {
  try {
    if (!await (deps.v3 ?? brandV3EnabledForOrg)(session.orgId)) return { ok: false, status: 404 };
    const authorized = await authorizeSettingsEdit(session);
    if (!authorized) return { ok: false, status: 403 };
    const value = input as Partial<OwnerViewSaveInput> | null;
    if (!value || typeof value !== "object" || !OWNER_VIEW_FIELDS.includes(value.field as OwnerViewField) || typeof value.value !== "boolean")
      return { ok: false, status: 400 };
    const privacy = await (deps.write ?? writeOwnerViewKey)(authorized, value.field as OwnerViewField, value.value, deps.audit);
    return { ok: true, privacy };
  } catch (error) {
    if (forbidden(error)) return { ok: false, status: 403 };
    logServerError("b073_owner_view_save", error);
    return { ok: false, status: 500 };
  }
}
