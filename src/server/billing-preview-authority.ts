import type { Client } from "pg";
import { billingPreviewsEnabled } from "./billing-preview-rules";
import { consentCoversCurrent, type StoredConsent } from "./consent";
import { can } from "./perms";
import type { Session } from "./types";

/** Call in an authenticated read-only transaction pinned to the server-selected scope.
 * RR fixes the database snapshot: subsequent revocations are visible on the next request.
 * The authenticated role stays in place while the live-parent scope is checked sequentially. */
export async function billingPreviewAuthorityOn(client: Client, session: Session): Promise<boolean> {
  if (session.kind !== "staff" || !can(session, "props.view") || session.needsSandbox ||
      !consentCoversCurrent(session.consent ?? null) || session.partnerConsent?.required) return false;
  const selected = await client.query<{ consent: StoredConsent | null; pin: string; env: string; live_id: string }>(`SELECT
      current_setting('app.active_org_id',true) AS pin, current_setting('app.env',true) AS env,
      coalesce(o.live_org_id,o.id)::text AS live_id,
      (SELECT jsonb_build_object('accepted_at',c.accepted_at,'terms_version',c.terms_version,
          'privacy_version',c.privacy_version,'source',c.source)
         FROM consents c WHERE c.user_id=auth.uid() ORDER BY c.recorded_at DESC,c.id DESC LIMIT 1) AS consent
    FROM organizations o
    JOIN auth_sessions s ON s.id=$3 AND s.user_id=auth.uid() AND s.revoked_at IS NULL AND s.expires_at>clock_timestamp()
    WHERE current_user='authenticated' AND o.id=$1 AND o.environment::text=$2 AND coalesce(o.live_org_id,o.id)=$4
      AND ((o.environment='live' AND o.live_org_id IS NULL AND o.id=$4)
        OR (o.environment='sandbox' AND o.live_org_id=$4 AND o.id<>$4))
      AND current_setting('app.active_org_id',true)=o.id::text AND current_setting('app.env',true)=o.environment::text`,
    [session.orgId,session.environment,session.sessionId,session.liveOrgId]);
  const scope = selected.rows[0];
  if (!scope || !consentCoversCurrent(scope.consent)) return false;
  let parentAllowed = false;
  try {
    await client.query(`SELECT set_config('app.active_org_id',$1,true),set_config('app.env','live',true)`, [scope.live_id]);
    const parent = await client.query(`SELECT 1 FROM organizations o JOIN org_members m ON m.org_id=o.id
      WHERE o.id=$1 AND o.environment='live' AND o.live_org_id IS NULL
        AND m.user_id=auth.uid() AND m.status='active' AND m.role::text IN ('admin','manager','accountant')`, [scope.live_id]);
    parentAllowed = parent.rows.length === 1;
  } finally {
    // Restore the original validated pin even on errors; a restore error aborts the transaction.
    await client.query(`SELECT set_config('app.active_org_id',$1,true),set_config('app.env',$2,true)`, [scope.pin,scope.env]);
  }
  if (!parentAllowed || !(await billingPreviewsEnabled(client,session.orgId))) return false;
  // A session can expire while the checks run even though RR retains the same snapshot.
  const current = await client.query(`SELECT 1 FROM auth_sessions WHERE id=$1 AND user_id=auth.uid()
    AND revoked_at IS NULL AND expires_at>clock_timestamp()`, [session.sessionId]);
  return current.rows.length === 1;
}
