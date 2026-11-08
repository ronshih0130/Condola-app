import { guardEffectiveSession } from "@/server/b017-custom-role-governance";
import { query } from "./db";
import { FlowError } from "./errors";
import { normalizeEmail } from "./auth";
import { assertPerm } from "./perms";
import { readMemberPrefs, readTenantToggles } from "./reminders";
import type { Session } from "./types";

function missingRelation(error: unknown) {
  const code = typeof error === "object" && error && "code" in error ? String((error as { code?: string }).code) : "";
  return code === "42P01" || code === "42703";
}

export async function memberEmailPrefs(orgId: string, userId: string) {
  try {
    const row = await query<{ email_prefs: unknown }>(
      `SELECT email_prefs FROM org_members WHERE org_id = $1 AND user_id = $2`,
      [orgId, userId],
    );
    if (!row.rows[0]) return null;
    return readMemberPrefs(row.rows[0].email_prefs);
  } catch (error) {
    if (missingRelation(error)) return null;
    throw error;
  }
}

export async function saveMemberEmailPrefs(session: Session, input: { leaseExpiry: boolean; rentOverdue: boolean }) {
  session = await guardEffectiveSession(session, "settings.edit");
  if (session.kind !== "staff" || (session.role !== "admin" && session.role !== "manager")) {
    throw new FlowError("errors.forbidden");
  }
  await query(
    `UPDATE org_members
        SET email_prefs = jsonb_set(
              jsonb_set(coalesce(email_prefs, '{}'::jsonb), '{lease_expiry}', to_jsonb($3::boolean), true),
              '{rent_overdue}', to_jsonb($4::boolean), true
            ),
            updated_at = now()
      WHERE org_id = $1 AND user_id = $2`,
    [session.orgId, session.userId, input.leaseExpiry, input.rentOverdue],
  );
}

export async function orgMailSettings(orgId: string) {
  try {
    const row = await query<{ contact_email: string | null; contact_phone: string | null; settings: unknown }>(
      `SELECT contact_email::text AS contact_email, contact_phone, settings FROM organizations WHERE id = $1`,
      [orgId],
    );
    const found = row.rows[0];
    if (!found) return null;
    const toggles = readTenantToggles(found.settings);
    return {
      contactEmail: found.contact_email ?? "",
      contactPhone: found.contact_phone ?? "",
      tenantLease: toggles.leaseExpiry,
      tenantOverdue: toggles.rentOverdue,
    };
  } catch (error) {
    if (missingRelation(error)) return null;
    throw error;
  }
}

export async function saveOrgMailSettings(
  session: Session,
  input: { tenantLease: boolean; tenantOverdue: boolean; contactEmail: string; contactPhone: string },
) {
  session = await guardEffectiveSession(session, "settings.edit");
  assertPerm(session, "settings.edit");
  const email = input.contactEmail.trim() ? normalizeEmail(input.contactEmail) : null;
  if (input.contactEmail.trim() && !email) throw new FlowError("errors.email");
  const phone = input.contactPhone.trim().slice(0, 40);
  await query(
    `UPDATE organizations
        SET contact_email = $2,
            contact_phone = NULLIF($3, ''),
            settings = jsonb_set(
              jsonb_set(coalesce(settings, '{}'::jsonb), '{email_tenant_lease_expiry}', to_jsonb($4::boolean), true),
              '{email_tenant_rent_overdue}', to_jsonb($5::boolean), true
            ),
            updated_at = now()
      WHERE id = $1`,
    [session.orgId, email, phone, input.tenantLease, input.tenantOverdue],
  );
}
