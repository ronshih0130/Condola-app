import { NextResponse } from "next/server";
import { makeT } from "@/i18n";
import { brandV2Enabled } from "../brand-v2";
import { FlowError } from "../errors";
import { submitVendorReportOn } from "../vendor-repair";
import { channelOn, lineTransaction, type LineFlow } from "./login-link";
import { equalHash, lineHash, rejectLine } from "./login-token";
import { body, browserProof, cookie, csrfCheck, envGate, lineResponse, privateHeaders } from "./login-routes";
import { LINE_JOB_COOKIE, vendorScopeOn, vendorViewOn } from "./vendor-scope";
import type { Client } from "pg";

async function scoped<T>(request: Request, write: boolean, work: (c: Client, job: Awaited<ReturnType<typeof vendorScopeOn>>) => Promise<T>) {
 envGate();
 if (new URL(request.url).search) rejectLine(404, "not_found");
 const claim = cookie(request, LINE_JOB_COOKIE);
 if (!claim) {
  const enabled = await lineTransaction(async c => (await c.query("SELECT 1 FROM organizations WHERE app.b033_portal_enabled(id,'vendor') LIMIT 1")).rowCount);
  if (!enabled) rejectLine(404, "not_found");
  rejectLine(401, "reauth_required");
 }
 return lineTransaction(async c => {
  const row = (await c.query<LineFlow & { job_id: string; token_hash: string; claim_expires_at: Date; identity_id: string | null; link_id: string | null }>(
   `SELECT f.*,v.job_id,v.token_hash,v.claim_expires_at,v.identity_id,v.link_id FROM app.b035_vendor_flows v
    JOIN app.b033_line_flows f ON f.id=v.flow_id WHERE v.claim_hash=$1 FOR SHARE OF f,v`, [lineHash(claim)])).rows[0];
  if (!row || row.persona !== "vendor" || !row.consumed_at || !row.verified_hash) rejectLine(404, "not_found");
  const channel = await channelOn(c, row.org_id, "vendor");
  const proof = browserProof(request);
  if (channel.id !== row.line_channel_id || !equalHash(proof.browser, row.browser_hash) || !equalHash(proof.csrf, row.csrf_hash)) rejectLine(401, "reauth_required");
  if (write) {
   const input = await body(request); csrfCheck(request, proof, input.csrf);
  }
  if (row.claim_expires_at.getTime() <= Date.now()) rejectLine(404, "not_found");
  // Same key as app.b033_link: also fences insertion when no identity row exists yet.
  await c.query("SELECT pg_advisory_xact_lock(hashtextextended($1::text||$2::text,33))", [row.line_channel_id,row.verified_hash]);
  if (row.identity_id) {
   const identity = (await c.query(`SELECT 1 FROM app.b033_line_identities i JOIN line_account_links l ON l.login_identity_id=i.id
    WHERE i.id=$1 AND l.id=$2 AND i.status='linked' AND i.unlinked_at IS NULL AND l.status='linked' AND l.unlinked_at IS NULL
     AND l.org_id=$3 AND l.persona='vendor' AND app.b033_contact_user(l.org_id,l.contact_id,'vendor')=i.user_id
    FOR SHARE OF i,l`, [row.identity_id,row.link_id,row.org_id])).rows[0];
   if (!identity) rejectLine(404, "not_found");
  } else if ((await c.query(`SELECT 1 FROM app.b033_line_identities WHERE line_channel_id=$1 AND provider_user_hash=$2
   FOR SHARE`, [row.line_channel_id,row.verified_hash])).rows[0]) {
   // A later account binding changes the authentication context. Require a fresh flow;
   // the anonymous claim must not survive org unlink or resurrect after re-binding.
   rejectLine(404, "not_found");
  }
  const job = await vendorScopeOn(c, row.token_hash, row.org_id, write);
  if (job.job_id !== row.job_id || row.claim_expires_at.getTime() <= Date.now()) rejectLine(404, "not_found");
  try { return await work(c, job); }
  catch (error) {
   if (error instanceof FlowError) rejectLine(error.key === "errors.required" ? 400 : 404,
    error.key === "errors.required" ? "invalid_request" : "not_found");
   throw error;
  }
 });
}
export const vendorJobGET = (request: Request) => lineResponse(async () =>
 NextResponse.json(await scoped(request, false, vendorViewOn), { headers: privateHeaders }));
export const vendorJobPOST = (request: Request) => lineResponse(async () => {
 // Clone once: scoped validates the original body and Origin before the writer sees it.
 const copy = request.clone();
 await scoped(request, true, async (c, job) => {
  const input = await body(copy);
  if (Object.keys(input).some(k => !["csrf", "done", "cost"].includes(k)) || input.done !== "true" || !input.cost) rejectLine(400, "invalid_request");
  const hash = (await c.query("SELECT token_hash FROM repair_vendor_jobs WHERE id=$1 AND org_id=$2", [job.job_id,job.org_id])).rows[0].token_hash;
  await submitVendorReportOn(c, job, hash, { done: true, cost: input.cost });
 });
 return NextResponse.json({ status: "reported" }, { headers: privateHeaders });
});
function escape(s: string) { return s.replace(/[&<>"']/g, ch => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch]!); }
export const vendorJobPage = async (request: Request) => {
 const result = await lineResponse(async () => {
  const job = await scoped(request, false, vendorViewOn);
  const locale = cookie(request,"condola_locale") === "en" ? "en" : "zh-TW";
  const t = makeT(locale), v2 = brandV2Enabled();
  const styles = v2 ? '<link rel="stylesheet" href="/brand/v2/theme.css"><link rel="stylesheet" href="/brand/v2/pages/v-job.css">' : "";
  const form = job.capability === "write" && !job.reported ? `<form id="vendor-report" data-v2-report="vendor"><label class="small"><input name="done" type="checkbox" required>${escape(t("i_vlink_done"))}</label><div class="fg"><label class="f" for="vendor-cost">${escape(t("i_vendor_cost"))} (${escape(job.currency)})</label><input class="inp" id="vendor-cost" name="cost" inputmode="decimal" required></div><button class="btn pri" data-testid="vendor-submit" type="submit">${escape(t("i_vendor_submit"))}</button></form><p id="report-error" role="alert" hidden>${escape(t("i_generic"))}</p><script src="/line-vendor-job.js" defer></script>` : `<p data-v2-status="${job.reported ? "sent" : "readonly"}">${escape(t(job.reported ? "i_vendor_sent" : "i_vendor_job_closed"))}</p>`;
  return new NextResponse(`<!doctype html><html lang="${locale}"${v2 ? ' data-brand="v2"' : ""}><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="referrer" content="no-referrer"><title>${escape(t("i_vendor_page_title"))}</title>${styles}</head><body><main data-v2-page="v-job"><h1>${escape(t("i_vendor_page_title"))}</h1><p class="f">${escape(t("i_vendor_issue"))}</p><p>${escape(job.description)}</p><p class="f">${escape(t("i_vendor_address"))}</p><p data-testid="vendor-address">${escape(job.address)}</p><p class="f">${escape(t("i_vendor_window"))}</p><p>${escape(job.window)}</p>${form}<a href="/login">${escape(t("i_login_title"))}</a></main></body></html>`,
   { headers: { ...privateHeaders, "Content-Type": "text/html; charset=utf-8", "Content-Security-Policy": "default-src 'none'; script-src 'self'; style-src 'self'; font-src 'self'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'" } });
 });
 if ([401,403].includes(result.status)) return new NextResponse(null, { status: 303, headers: { ...privateHeaders, Location: "/login" } });
 return result;
};
