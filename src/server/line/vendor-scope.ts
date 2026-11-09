import { randomBytes } from "node:crypto";
import type { Client } from "pg";
import { lockTicketThenJobs } from "../vendor-repair";
import { vendorLinkCapability, vendorLinkSafeView } from "../vendor-link-rules";
import { lineHash, rejectLine } from "./login-token";
import type { LineFlow } from "./login-link";

export const LINE_JOB_COOKIE = "condola_line_job";
export type VendorScope = {
 job_id: string; org_id: string; ticket_id: string; vendor_name: string; contact_window: string;
 expires_at: string; reported_at: string | null; reported_cost_minor: string | null;
 capability: "write" | "read_only";
};
/** Original vendor token rules, plus mandatory assignment/sharing. No legacy cleanup writes. */
export async function vendorScopeOn(c: Client, hash: string, expectedOrg?: string, write = false): Promise<VendorScope> {
 const peek = (await c.query("SELECT id,org_id,ticket_id FROM repair_vendor_jobs WHERE token_hash=$1", [hash])).rows[0];
 if (!peek || expectedOrg && peek.org_id !== expectedOrg) rejectLine(404, "not_found");
 await lockTicketThenJobs(c, peek.org_id, peek.ticket_id);
 const job = (await c.query(`SELECT o.*,j.active,j.revoked_at,t.status FROM app.open_vendor_job($1) o
  JOIN repair_vendor_jobs j ON j.id=o.job_id AND j.org_id=o.org_id
  JOIN maintenance_tickets t ON t.id=j.ticket_id AND t.org_id=j.org_id
  JOIN contacts v ON v.id=j.vendor_contact_id AND v.org_id=j.org_id
  WHERE j.vendor_contact_id=t.assigned_vendor_contact_id AND j.scope='case_collaboration'
   AND j.sharing_approved_at IS NOT NULL AND v.is_vendor AND v.archived_at IS NULL`, [hash])).rows[0];
 if (!job) rejectLine(404, "not_found");
 const capability = vendorLinkCapability({ active: job.active, revokedAt: job.revoked_at,
  expiresAt: job.expires_at, ticketStatus: job.status, now: new Date() });
 if (capability === "invalid" || write && capability !== "write") rejectLine(404, "not_found");
 return { ...job, capability };
}
export async function finishVendorFlowOn(c: Client, f: LineFlow) {
 const scope = (await c.query("SELECT * FROM app.b035_vendor_flows WHERE flow_id=$1", [f.id])).rows[0];
 if (!scope) return null;
 if (!f.verified_hash || f.persona !== "vendor" || f.kind !== "login") rejectLine(404, "not_found");
 await c.query("SELECT pg_advisory_xact_lock(hashtextextended($1::text||$2::text,33))", [f.line_channel_id,f.verified_hash]);
 const job = await vendorScopeOn(c, scope.token_hash, f.org_id);
 if (job.job_id !== scope.job_id) rejectLine(404, "not_found");
 const identity = (await c.query(`SELECT * FROM app.b033_line_identities
  WHERE line_channel_id=$1 AND provider_user_hash=$2 FOR SHARE`, [f.line_channel_id, f.verified_hash])).rows[0];
 const link = identity && (await c.query(`SELECT id FROM line_account_links WHERE login_identity_id=$1
  AND org_id=$2 AND persona='vendor' AND status='linked' AND unlinked_at IS NULL
  AND app.b033_contact_user(org_id,contact_id,'vendor')=$3 FOR SHARE`, [identity.id, f.org_id, identity.user_id])).rows[0];
 if (identity && (identity.status !== "linked" || identity.unlinked_at || !link)) rejectLine(404, "not_found");
 const jobClaim = randomBytes(32).toString("base64url");
 await c.query(`UPDATE app.b035_vendor_flows SET claim_hash=$2,
  claim_expires_at=least(clock_timestamp()+interval '5 minutes',$3::timestamptz),identity_id=$4,link_id=$5 WHERE flow_id=$1`,
  [f.id, lineHash(jobClaim), job.expires_at, identity?.id ?? null, link?.id ?? null]);
 await c.query("UPDATE app.b033_line_flows SET consumed_at=clock_timestamp() WHERE id=$1", [f.id]);
 return { next: "/v/liff/job", jobClaim };
}
export async function vendorViewOn(c: Client, job: VendorScope) {
 const row = (await c.query(`SELECT j.shared_description description,j.contact_window AS window,
  coalesce(nullif(btrim(p.address_display),''),p.name) address,coalesce(u.label,'') place,
  p.currency,j.reported_at IS NOT NULL reported,t.status,j.expires_at::text AS "expiresAt"
  FROM repair_vendor_jobs j JOIN maintenance_tickets t ON t.id=j.ticket_id AND t.org_id=j.org_id
  JOIN properties p ON p.id=t.property_id AND p.org_id=t.org_id
  LEFT JOIN units u ON u.id=t.unit_id AND u.org_id=t.org_id WHERE j.id=$1 AND j.org_id=$2`,
  [job.job_id, job.org_id])).rows[0];
 if (!row) rejectLine(404, "not_found");
 return { ...vendorLinkSafeView(row), currency: row.currency, reported: row.reported, capability: job.capability };
}
