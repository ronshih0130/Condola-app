import { guardEffectiveSession } from "./b017-custom-role-governance";
import { setOwnerPrivacy } from "./auth";
import { FlowError, logServerError } from "./errors";
import { assertPerm } from "./perms";
import { privacyFromSettings, type OwnerPrivacy } from "./privacy";
import type { Session } from "./types";

/**
 * B-073 / R5-OWNVIEW (設定 › 規則與資料 › 屋主看得到什麼, MGT-138). The same company-wide owner-privacy setting as
 * today's `ownerPrivacy` / `setOwnerPrivacy` (organizations.settings show_tenant_name default true,
 * show_tenant_phone default false), admin only (`settings.edit`). Nothing is sent to owners (MGT-138-AC2):
 * the save writes the two keys and the existing `owner_privacy` audit row, nothing else.
 */
export type OwnerViewField = keyof OwnerPrivacy;
export const OWNER_VIEW_FIELDS: readonly OwnerViewField[] = ["showName", "showPhone"];
export type OwnerViewCompany = { name: string; taxId: string | null };
export type OwnerViewRead =
  | { state: "forbidden" | "unavailable" }
  | { state: "ready"; privacy: OwnerPrivacy; company: OwnerViewCompany };
export type OwnerViewSaveInput = { field: OwnerViewField; value: boolean };
/** The action answers a result (it never redirects). 403 = not allowed (MGT-138-AC3); 400 = bad input. */
export type OwnerViewSaveResult = { ok: true; privacy: OwnerPrivacy } | { ok: false; status: 400 | 403 | 500 };

type Row = { settings: unknown; name: string | null; tax_id: string | null };
async function readOrganization(orgId: string): Promise<Row | undefined> {
  const { query } = await import("./db");
  return (await query<Row>("SELECT settings, name, tax_id FROM organizations WHERE id = $1", [orgId])).rows[0];
}
type Deps = { read?: typeof readOrganization; save?: typeof setOwnerPrivacy };
const forbidden = (error: unknown) => error instanceof FlowError && error.key === "errors.forbidden";

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

/**
 * One switch saves at a time: the other value is read fresh after the permission check, so a change made
 * elsewhere to the other switch is kept, then both are written through the existing `setOwnerPrivacy`
 * (which repeats the `settings.edit` guard inside its transaction).
 */
export async function saveOwnerView(session: Session, input: unknown, deps: Deps = {}): Promise<OwnerViewSaveResult> {
  const value = input as Partial<OwnerViewSaveInput> | null;
  if (!value || typeof value !== "object" || !OWNER_VIEW_FIELDS.includes(value.field as OwnerViewField) || typeof value.value !== "boolean")
    return { ok: false, status: 400 };
  try {
    session = await guardEffectiveSession(session, "settings.edit");
    assertPerm(session, "settings.edit");
    const row = await (deps.read ?? readOrganization)(session.orgId);
    if (!row) return { ok: false, status: 500 };
    const privacy: OwnerPrivacy = { ...privacyFromSettings(row.settings ?? null), [value.field as OwnerViewField]: value.value };
    await (deps.save ?? setOwnerPrivacy)(session, { showName: privacy.showName, showPhone: privacy.showPhone });
    return { ok: true, privacy };
  } catch (error) {
    if (forbidden(error)) return { ok: false, status: 403 };
    logServerError("b073_owner_view_save", error);
    return { ok: false, status: 500 };
  }
}
