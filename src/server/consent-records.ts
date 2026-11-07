import { tx } from "./db";
import { requireOrgScope } from "./org-guard";
import type { Session } from "./types";

export type ConsentRecord = {
  kind: "terms_privacy" | "partner_agreement" | "partner_privacy" | "id_notice" | "lease_signature";
  scope_org_id: string | null;
  document_ref: string;
  accepted_at: string;
  source: string;
  record_id: string;
};

/** Account-wide legal acceptance plus own evidence in the session's pinned org. */
export async function myConsentRecords(session: Session): Promise<ConsentRecord[]> {
  return tx(session.userId, async (client) => {
    const result = await client.query<ConsentRecord>(
      `SELECT kind, scope_org_id::text, document_ref, accepted_at::text, source, record_id
         FROM app.prop04_my_consent_records() AS records
        ORDER BY records.accepted_at DESC, source, record_id, kind`,
    );
    return result.rows;
  }, requireOrgScope(session), { readOnly: true });
}
