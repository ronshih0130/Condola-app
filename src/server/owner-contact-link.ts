import { tx } from "./db";
import { FlowError } from "./errors";
import { requireOrgScope } from "./org-guard";
import { isUuid } from "./repair-rules";
import type { Session } from "./types";

/**
 * PROP-13 (BLK-MAC-04): trusted owner-contact login linking. An org admin
 * provisions a NEW portal login for an unbound owner contact; existing
 * accounts (including the caller's) can never be bound. Flag owner_contact_linking
 * (default OFF) is enforced inside app.prop13_link_owner_contact.
 */
export async function linkOwnerContactPortal(session: Session, input: { contactId: string; email: string }) {
  if (session.kind !== "staff" || session.role !== "admin") throw new FlowError("errors.forbidden");
  const email = typeof input.email === "string" ? input.email.trim().toLowerCase() : "";
  if (!isUuid(input.contactId) || !/^[^@\s]+@[^@\s]+$/.test(email) || email.length > 254) throw new FlowError("errors.generic");
  return tx(session.userId, async (client) => {
    try {
      const row = (await client.query<{ user_id: string }>(
        `SELECT app.prop13_link_owner_contact($1,$2,$3)::text AS user_id`,
        [session.orgId, input.contactId, email],
      )).rows[0];
      return { userId: row.user_id };
    } catch (error) {
      const code = (error as { code?: string }).code;
      if (code === "42501") throw new FlowError("errors.forbidden");
      if (code === "23505") throw new FlowError("errors.emailTaken");
      throw error;
    }
  }, requireOrgScope(session));
}
