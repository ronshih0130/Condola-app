import { tx } from "./db";
import { requireOrgScope } from "./org-guard";
import { planChannels, type Channel, type Portal } from "./recipient-channels-rules";
import type { Session } from "./types";

/** Staff-only, pinned-scope trusted channel plan for one contact (no addresses or LINE ids returned). */
/** `persona` is the event's intended recipient role (contacts can hold several). */
export async function recipientChannelPlan(session: Session, contactId: string, persona: Portal, requested?: readonly Channel[]) {
  if (session.kind !== "staff") return null;
  return tx(session.userId, async (client) => {
    const row = (await client.query<{ portal: Portal | null; email_available: boolean; in_app_available: boolean; line_bound: boolean; line_friend: boolean }>(
      `SELECT * FROM app.prop06_recipient_channels($1,$2,$3)`, [session.orgId, contactId, persona])).rows[0];
    if (!row) return null;
    return planChannels({ portal: row.portal, emailAvailable: row.email_available, inAppAvailable: row.in_app_available, lineBound: row.line_bound, lineFriend: row.line_friend }, requested);
  }, requireOrgScope(session), { readOnly: true });
}
