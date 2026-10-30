import { EsignDenied } from "./access";
import type { Connection } from "./repo";

export type ReviewBinding = {
  caseId: string;
  versionId: string;
  signerId: string;
  digest: string;
};

/**
 * Delivery evidence means the server prepared the complete document, either in
 * one response or across every page response. It does not prove human reading.
 * The review command is the signer's acknowledgement of that delivery.
 *
 * Existing append-only audit storage provides durability across Workers and
 * sessions, with the case's retention policy. Callers hold the case lock and
 * authorize the signer before recording or checking this evidence.
 */
export async function recordReviewDelivery(
  c: Connection,
  binding: ReviewBinding,
  page: number | null,
) {
  await c.query(
    `INSERT INTO esign_audit_events(case_id, version_id, event_type, payload)
     VALUES ($1,$2,'review_delivery',$3::jsonb)`,
    [binding.caseId, binding.versionId, JSON.stringify({ ...binding, page })],
  );
}

export async function requireReviewDelivery(
  c: Connection,
  binding: ReviewBinding,
  pages: number,
) {
  const result = await c.query<{ payload: { page: number | null } }>(
    `SELECT payload FROM esign_audit_events
     WHERE case_id=$1 AND version_id=$2 AND actor_id=$3
       AND event_type='review_delivery' AND payload @> $4::jsonb`,
    [binding.caseId, binding.versionId, binding.signerId, JSON.stringify(binding)],
  );
  const delivered = new Set(result.rows.map((row) => row.payload.page));
  if (delivered.has(null)) return;
  for (let page = 1; page <= pages; page++) {
    if (!delivered.has(page)) throw new EsignDenied("Document delivery required before acknowledgement");
  }
}
