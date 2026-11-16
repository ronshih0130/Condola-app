import { NextResponse } from "next/server";
import { SESSION_COOKIE, sessionCookie } from "../auth";
import { ORG_COOKIE } from "../org-scope";
import { PORTAL_ROLE_COOKIE } from "../portal-role";
import { vendorLineMatchCopy as copy } from "../../i18n/lanes/vendor-line-match";
import { consentNextOn, createLineFlow, credentialsOn, lineSessionOn, lineTransaction, sessionOn } from "./login-link";
import { body, browserProof, cookie, csrfCheck, envGate, LINE_FLOW_COOKIE, lineCookie, lineResponse, privateHeaders } from "./login-routes";
import { rejectLine } from "./login-token";
import { vendorMatchContextOn, vendorMatchReviewOn } from "./vendor-match";

const escape = (value: string) => value.replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
const meta = (r: Request) => ({ ua: r.headers.get("user-agent"), ip: null });
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const vendorMatchGET = (request: Request) => lineResponse(async () => {
 envGate();
 const proof = browserProof(request), handle = cookie(request, LINE_FLOW_COOKIE) ?? "";
 const recovery = await lineTransaction(c => vendorMatchContextOn(c, handle, proof, true));
 let jobs: { id: string; description: string }[] = [], failed = new URL(request.url).searchParams.has("error");
 if (!failed) {
  try { jobs = await lineTransaction(async c => {
   const { f } = await vendorMatchContextOn(c, handle, proof);
   return (await vendorMatchReviewOn(c, f, "list")).jobs;
  }); } catch { failed = true; }
 }
 const data = JSON.stringify({ csrf: proof.csrf }).replace(/</g, "\\u003c");
 const rows = jobs.map(j => `<li data-job="${escape(j.id)}"><span>${escape(j.description)}</span><button type="button" data-remove="${escape(j.id)}" class="v-token-secondary">${copy.remove}</button></li>`).join("");
 const html = `<!doctype html><html lang="zh-TW" data-brand="v2" data-brand-v3><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="referrer" content="no-referrer"><link rel="stylesheet" href="/brand/v2/theme.css"><link rel="stylesheet" href="/brand/v3/theme.css"><link rel="stylesheet" href="/brand/v3/vendor-token.css"><title>${copy.title}</title></head><body><div class="v-token-v3"><main class="v-token-main"><section class="v-token-card"><h1>${copy.title}</h1><div id="match-review"${failed ? " hidden" : ""}><p>${copy.body}</p><ul id="match-jobs">${rows}</ul><button type="button" id="match-confirm" class="v-token-primary">${copy.continue}</button><p>${copy.note}</p><p id="match-toast" role="status" data-template="${copy.removed}"></p></div><div id="match-error"${failed ? "" : " hidden"}><p role="alert">${copy.error}</p><button type="button" id="match-retry" class="v-token-secondary">${copy.retry}</button><a href="${escape(recovery.back)}" referrerpolicy="no-referrer">${copy.back}</a></div><script type="application/json" id="match-bootstrap">${data}</script><script src="/vendor-line-match.js" defer></script></section></main></div></body></html>`;
 return new NextResponse(html, { headers: { ...privateHeaders, "Content-Type": "text/html; charset=utf-8",
  "Content-Security-Policy": "default-src 'none'; script-src 'self'; style-src 'self'; font-src 'self'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'" } });
});

export const vendorMatchPOST = (request: Request) => lineResponse(async () => {
 envGate(); const b = await body(request), proof = browserProof(request); csrfCheck(request, proof, b.csrf);
 if (!['remove', 'confirm', 'retry'].includes(b.action) || Object.keys(b).some(k => !['action', 'jobId', 'csrf'].includes(k))
  || (b.action === 'remove' ? !uuid.test(b.jobId ?? '') : b.jobId !== undefined)) rejectLine(400, "invalid_request");
 const handle = cookie(request, LINE_FLOW_COOKIE) ?? "";
 if (b.action === "retry") {
  const { f, jobToken } = await lineTransaction(c => vendorMatchContextOn(c, handle, proof, true));
  const flow = await createLineFlow({ purpose: "login", persona: "vendor", orgId: f.org_id, jobToken, vendorMatch: "true" }, proof);
  const res = NextResponse.json({ next: `/v/liff?flow=${flow.flow}` }, { headers: privateHeaders });
  lineCookie(res, LINE_FLOW_COOKIE, flow.flow); return res;
 }
 const result = await lineTransaction(async c => {
  const { f } = await vendorMatchContextOn(c, handle, proof);
  const review = await vendorMatchReviewOn(c, f, b.action as "remove" | "confirm", b.jobId);
  const sessionToken = cookie(request, SESSION_COOKIE), existing = await sessionOn(c, sessionToken);
  if (existing && existing.user_id !== review.userId) rejectLine(409, "account_mismatch");
  if (b.action === "remove") return { jobs: review.jobs };
  await credentialsOn(c, review.userId, { sessionToken }, false);
  const token = await lineSessionOn(c, f, review.userId, review.identityId, meta(request), sessionToken);
  // Existing B026 portal exists. B063 workbench is deliberately not implemented here.
  const next = await consentNextOn(c, review.userId, { persona: "vendor", return_path: "/vendor-account" });
  return { next, token, orgId: review.orgId };
 });
 const res = NextResponse.json("token" in result ? { next: result.next } : result, { headers: privateHeaders });
 if ("token" in result && result.token) {
  const co = sessionCookie(result.token, false); res.cookies.set(co.name, co.value, { ...co.options, secure: true });
  const opts = { secure: true, httpOnly: true, sameSite: "lax" as const, path: "/" };
  res.cookies.set(ORG_COOKIE, result.orgId!, opts); res.cookies.set(PORTAL_ROLE_COOKIE, "vendor", opts);
  res.cookies.set("condola_lease", "", { ...opts, maxAge: 0 });
 }
 return res;
});
