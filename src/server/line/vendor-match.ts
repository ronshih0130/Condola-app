import type { Client } from "pg";
import { brandV2Enabled } from "../brand-v2";
import { equalHash, lineHash, rejectLine } from "./login-token";
import { channelOn, type BrowserProof, type LineFlow } from "./login-link";

/** Consumed OAuth flows authorize only V-LINK, never a token-only list or account session. */
export async function vendorMatchContextOn(c: Client, handle: string, proof: BrowserProof, recovery = false) {
 const f = (await c.query<LineFlow>("SELECT * FROM app.b033_line_flows WHERE flow_hash=$1 FOR UPDATE", [lineHash(handle)])).rows[0];
 if (!f || f.return_path !== "/v/link" || f.persona !== "vendor" || f.kind !== "login"
  || !equalHash(proof.browser, f.browser_hash) || !equalHash(proof.csrf, f.csrf_hash)) rejectLine(404, "not_found");
 await channelOn(c, f.org_id, "vendor");
 if (!(await c.query("SELECT app.b101_enabled($1,$2) enabled", [f.org_id, brandV2Enabled()])).rows[0].enabled) rejectLine(404, "not_found");
 if (!recovery && (f.expires_at.getTime() <= Date.now() || !f.verified_hash || !f.consumed_at)) rejectLine(404, "not_found");
 // Only the proof-bound flow's original job can supply a back/retry path. No caller return URL.
 const job = (await c.query<{ token: string }>(`SELECT s.token FROM app.b035_vendor_flows v
  JOIN repair_vendor_jobs j ON j.id=v.job_id AND j.org_id=$2 AND j.token_hash=v.token_hash
  JOIN repair_vendor_secrets s ON s.job_id=j.id WHERE v.flow_id=$1`, [f.id, f.org_id])).rows[0];
 return { f, jobToken: job?.token, back: job ? `/v/${encodeURIComponent(job.token)}` : "/v/liff" };
}
export type VendorMatchReview = { jobs: { id: string; description: string }[]; userId: string; identityId: string; orgId: string };
export async function vendorMatchReviewOn(c: Client, f: LineFlow, action: "list" | "remove" | "confirm", jobId?: string) {
 return (await c.query<{ result: VendorMatchReview }>("SELECT app.b101_review($1,$2,$3,$4) result",
  [f.id, brandV2Enabled(), action, jobId ?? null])).rows[0].result;
}
