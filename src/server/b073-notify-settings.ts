import { guardEffectiveSession, requireEffectivePerm } from "./b017-custom-role-governance";
import { FlowError, logServerError } from "./errors";
import { requireOrgScope } from "./org-guard";
import { assertPerm, can, hasPersonalReminders } from "./perms";
import { readMemberPrefs, readTenantToggles } from "./reminders";
import type { Session } from "./types";

/**
 * B-073 / R5-NOTIFY (設定 › 通知設定, MGT-135). One page for the reminder switches that exist today:
 * - 「寄給我的」: the caller's own `org_members.email_prefs` (lease_expiry, rent_overdue), admin and manager as on
 *   我的帳號 today (`memberEmailPrefs` / `saveMemberEmailPrefs`);
 * - 「寄給租客的」: the company's `organizations.settings` email_tenant_lease_expiry / email_tenant_rent_overdue
 *   (`orgMailSettings` / `saveOrgMailSettings`), admin only (settings.edit, MGT-135-AC4).
 * The scheduled sender (reminders.ts) reads the same keys with the same parsers, so its behaviour is unchanged.
 * Settings only (MGT-135-AC3): a save writes one key and nothing else — no mail, queue, LINE or push call. Audit
 * mirrors the existing mail-settings writes: no app-level audit row; the generic fn_audit row trigger on
 * organizations / org_members records each save in the same statement.
 */
export type NotifyBlock = "me" | "tenant";
export type NotifyField = "leaseExpiry" | "rentOverdue";
export type NotifyToggles = Record<NotifyField, boolean>;
export const NOTIFY_BLOCKS: readonly NotifyBlock[] = ["me", "tenant"];
export const NOTIFY_FIELDS: readonly NotifyField[] = ["leaseExpiry", "rentOverdue"];
export type NotifyRead =
  | { state: "forbidden" | "unavailable" }
  | { state: "ready"; me: NotifyToggles; tenant: NotifyToggles | null };
export type NotifySaveInput = { block: NotifyBlock; field: NotifyField; value: boolean };
/**
 * POST /api/notify-settings answers this as its HTTP status. 403 = not allowed (MGT-135-AC4); 400 = bad input;
 * 404 = brand_v3 OFF for the session's organization (the R5-TEAM /api/team-security convention), nothing written.
 */
export type NotifySaveResult = { ok: true; block: NotifyBlock; toggles: NotifyToggles } | { ok: false; status: 400 | 403 | 404 | 500 };

/** The stored key each switch owns (closed sets; never built from input). */
const MEMBER_KEY: Record<NotifyField, string> = { leaseExpiry: "lease_expiry", rentOverdue: "rent_overdue" };
const TENANT_KEY: Record<NotifyField, string> = { leaseExpiry: "email_tenant_lease_expiry", rentOverdue: "email_tenant_rent_overdue" };

async function readMine(orgId: string, userId: string): Promise<unknown | undefined> {
  const { query } = await import("./db");
  const row = (await query<{ email_prefs: unknown }>("SELECT email_prefs FROM org_members WHERE org_id = $1 AND user_id = $2", [orgId, userId])).rows[0];
  return row ? row.email_prefs ?? {} : undefined;
}
async function readTenant(orgId: string): Promise<unknown | undefined> {
  const { query } = await import("./db");
  const row = (await query<{ settings: unknown }>("SELECT settings FROM organizations WHERE id = $1", [orgId])).rows[0];
  return row ? row.settings ?? {} : undefined;
}

/**
 * The caller's own row only (org_id + user_id from the session, never from input). One atomic statement sets ONLY
 * the changed key, through the same connection `saveMemberEmailPrefs` uses (org_members RLS admits only admins).
 */
async function writeMine(session: Session, field: NotifyField, value: boolean): Promise<NotifyToggles> {
  const { query } = await import("./db");
  const { rows } = await query<{ email_prefs: unknown }>(
    `UPDATE org_members
        SET email_prefs = jsonb_set(coalesce(email_prefs, '{}'::jsonb), $3::text[], to_jsonb($4::boolean), true),
            updated_at = now()
      WHERE org_id = $1 AND user_id = $2
  RETURNING email_prefs`,
    [session.orgId, session.userId, [MEMBER_KEY[field]], value],
  );
  if (!rows[0]) throw new Error("membership not found");
  return readMemberPrefs(rows[0].email_prefs);
}

/**
 * One atomic statement sets ONLY the changed company key, under the same in-transaction settings.edit guard and tx
 * helper as R5-OWNVIEW. `saveOrgMailSettings` (flag OFF form) is unchanged for its toggle path.
 */
async function writeTenant(session: Session, field: NotifyField, value: boolean): Promise<NotifyToggles> {
  const { tx } = await import("./db");
  return tx(session.userId, async (client) => {
    await requireEffectivePerm(client, session, "settings.edit");
    const { rows } = await client.query<{ settings: unknown }>(
      `UPDATE organizations
          SET settings = jsonb_set(coalesce(settings, '{}'::jsonb), $2::text[], to_jsonb($3::boolean), true),
              updated_at = now()
        WHERE id = $1
    RETURNING settings`,
      [session.orgId, [TENANT_KEY[field]], value],
    );
    if (!rows[0]) throw new Error("organization not found");
    return readTenantToggles(rows[0].settings);
  }, requireOrgScope(session));
}

type Deps = {
  readMine?: typeof readMine; readTenant?: typeof readTenant; writeMine?: typeof writeMine; writeTenant?: typeof writeTenant;
  /** brand_v3 for the org; a failed read throws (→ 500), never a silent ON or OFF. */
  v3?: (orgId: string) => Promise<boolean>;
};
const readV3 = async (orgId: string) => (await import("./brand-v3")).brandV3ReadForOrg(orgId);
const forbidden = (error: unknown) => (error instanceof FlowError && error.key === "errors.forbidden")
  || ((error as { code?: string } | null)?.code ?? (error as { cause?: { code?: string } } | null)?.cause?.code) === "42501";

/** The page reader. Not admin or manager: forbidden. The tenant block is read only for settings.edit (admin). */
export async function notifySettingsRead(session: Session, deps: Deps = {}): Promise<NotifyRead> {
  try {
    session = await guardEffectiveSession(session, "settings.edit");
    if (!hasPersonalReminders(session)) return { state: "forbidden" };
    const mine = await (deps.readMine ?? readMine)(session.orgId, session.userId);
    if (mine === undefined) return { state: "unavailable" };
    let tenant: NotifyToggles | null = null;
    if (can(session, "settings.edit")) {
      const settings = await (deps.readTenant ?? readTenant)(session.orgId);
      if (settings === undefined) return { state: "unavailable" };
      tenant = readTenantToggles(settings);
    }
    return { state: "ready", me: readMemberPrefs(mine), tenant };
  } catch (error) {
    if (forbidden(error)) return { state: "forbidden" };
    logServerError("b073_notify_read", error);
    return { state: "unavailable" };
  }
}

/**
 * One switch per save: only its key is written. 「寄給租客的」 needs settings.edit; 「寄給我的」 writes the caller's own row.
 * Order: the body (400), then authority for that block (403, whatever the flag), then brand_v3 for the session's
 * organization (OFF → 404, nothing written), then the single-key write.
 */
export async function saveNotifySetting(session: Session, input: unknown, deps: Deps = {}): Promise<NotifySaveResult> {
  const value = input as Partial<NotifySaveInput> | null;
  if (!value || typeof value !== "object" || !NOTIFY_BLOCKS.includes(value.block as NotifyBlock)
    || !NOTIFY_FIELDS.includes(value.field as NotifyField) || typeof value.value !== "boolean")
    return { ok: false, status: 400 };
  const block = value.block as NotifyBlock, field = value.field as NotifyField;
  try {
    session = await guardEffectiveSession(session, "settings.edit");
    if (block === "tenant") assertPerm(session, "settings.edit");
    else if (!hasPersonalReminders(session)) throw new FlowError("errors.forbidden");
    // 通知設定 is a brand_v3 page: the API is closed for an organization without it (flag OFF has no such page).
    if (!await (deps.v3 ?? readV3)(session.orgId)) return { ok: false, status: 404 };
    const write = block === "tenant" ? (deps.writeTenant ?? writeTenant) : (deps.writeMine ?? writeMine);
    return { ok: true, block, toggles: await write(session, field, value.value) };
  } catch (error) {
    if (forbidden(error)) return { ok: false, status: 403 };
    logServerError("b073_notify_save", error);
    return { ok: false, status: 500 };
  }
}
