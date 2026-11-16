import { NextResponse } from "next/server";
import { SESSION_COOKIE, sessionCookie } from "../auth";
import { ORG_COOKIE } from "../org-scope";
import { PORTAL_ROLE_COOKIE } from "../portal-role";
import { vendorLineMatchCopy as copy } from "../../i18n/lanes/vendor-line-match";
import { consentNextOn, createLineFlow, credentialsOn, lineSessionOn, lineTransaction, sessionOn } from "./login-link";
import { body, browserProof, cookie, csrfCheck, envGate, LINE_FLOW_COOKIE, lineCookie, lineResponse, privateHeaders } from "./login-routes";
import { LineError, rejectLine } from "./login-token";
import { vendorMatchContextOn, vendorMatchReviewOn } from "./vendor-match";

const escape = (value: string) => value.replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
const meta = (r: Request) => ({ ua: r.headers.get("user-agent"), ip: null });
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i, digest = /^[0-9a-f]{64}$/;

const shell = (content: string) => `<!doctype html><html lang="zh-TW" data-brand="v2" data-brand-v3><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="referrer" content="no-referrer"><link rel="stylesheet" href="/brand/v2/theme.css"><link rel="stylesheet" href="/brand/v3/theme.css"><link rel="stylesheet" href="/brand/v3/vendor-token.css"><title>${copy.title}</title></head><body><div class="v-token-v3"><main class="v-token-main"><section class="v-token-card"><h1>${copy.title}</h1>${content}</section></main></div></body></html>`;
const page = (html: string) => new NextResponse(html, { headers: { ...privateHeaders, "Content-Type": "text/html; charset=utf-8",
 "Content-Security-Policy": "default-src 'none'; script-src 'self'; style-src 'self'; font-src 'self'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'" } });
// Pre-flow failure (tokenless /v/liff?org= could not mint a flow): static approved error only. No flow is read or
// trusted, no data or script; 「再試一次」 restarts the same entry, rebuilt from a validated org UUID (never a caller URL).
// No proof-bound job exists, so 「先回這一案」 is not offered.
const preFlowError = (org: string | null) => page(shell(`<div id="match-error"><p role="alert">${copy.error}</p><a id="match-retry" class="v-token-secondary" href="${org && uuid.test(org) ? `/v/liff?org=${org.toLowerCase()}` : "/v/liff"}" referrerpolicy="no-referrer">${copy.retry}</a></div>`));

export const vendorMatchGET = (request: Request) => lineResponse(async () => {
 envGate();
 const params = new URL(request.url).searchParams, handle = cookie(request, LINE_FLOW_COOKIE) ?? "";
 let failed = params.has("error");
 // The bootstrap marks a pre-flow failure with its org hint; a missing or unknown flow on an error landing is the same case.
 if (failed && (params.has("org") || !handle)) return preFlowError(params.get("org"));
 const proof = browserProof(request);
 let recovery: Awaited<ReturnType<typeof vendorMatchContextOn>>;
 try { recovery = await lineTransaction(c => vendorMatchContextOn(c, handle, proof, true)); }
 catch (error) { if (failed && error instanceof LineError && error.status === 404) return preFlowError(null); throw error; }
 let jobs: { id: string; description: string }[] = [], snapshot = "";
 if (!failed) {
  try { ({ jobs, snapshot = "" } = await lineTransaction(async c => {
   const { f } = await vendorMatchContextOn(c, handle, proof);
   return vendorMatchReviewOn(c, f, "list");
  })); } catch { failed = true; }
 }
 // Every V-LINK action posts back the exact flow and frozen-list digest this page rendered (never the mutable cookie alone).
 const data = JSON.stringify({ csrf: proof.csrf, flow: recovery.f.id, snapshot }).replace(/</g, "\\u003c");
 // screens.md V-LINK: the removal note appears only after a removal, together with its toast.
 const rows = jobs.map(j => `<li data-job="${escape(j.id)}"><span>${escape(j.description)}</span><button type="button" data-remove="${escape(j.id)}" class="v-token-secondary">${copy.remove}</button></li>`).join("");
 // 「先回這一案」 only when the proof-bound flow has its original job token to return to.
 const back = recovery.jobToken ? `<a href="${escape(recovery.back)}" referrerpolicy="no-referrer">${copy.back}</a>` : "";
 return page(shell(`<div id="match-review"${failed ? " hidden" : ""}><p>${copy.body}</p><ul id="match-jobs">${rows}</ul><button type="button" id="match-confirm" class="v-token-primary">${copy.continue}</button><p id="match-toast" role="status" data-template="${copy.removed}"></p><p id="match-note" hidden>${copy.note}</p></div><div id="match-error"${failed ? "" : " hidden"}><p role="alert">${copy.error}</p><button type="button" id="match-retry" class="v-token-secondary">${copy.retry}</button>${back}</div><script type="application/json" id="match-bootstrap">${data}</script><script src="/vendor-line-match.js" defer></script>`));
});

export const vendorMatchPOST = (request: Request) => lineResponse(async () => {
 envGate(); const b = await body(request), proof = browserProof(request); csrfCheck(request, proof, b.csrf);
 if (!['remove', 'confirm', 'retry'].includes(b.action) || Object.keys(b).some(k => !['action', 'jobId', 'csrf', 'flow', 'snapshot'].includes(k))
  || (b.action === 'remove' ? !uuid.test(b.jobId ?? '') : b.jobId !== undefined) || !uuid.test(b.flow ?? '')
  || (b.action === 'retry' ? ![undefined, ''].includes(b.snapshot) && !digest.test(b.snapshot) : !digest.test(b.snapshot ?? ''))) rejectLine(400, "invalid_request");
 const handle = cookie(request, LINE_FLOW_COOKIE) ?? "";
 // A second tab replaces the flow cookie: an action from a page rendered for another flow is refused before any write.
 const rendered = (f: { id: string }) => { if (f.id !== b.flow) rejectLine(404, "not_found"); };
 if (b.action === "retry") {
  const { f, jobToken } = await lineTransaction(async c => { const r = await vendorMatchContextOn(c, handle, proof, true); rendered(r.f); return r; });
  const flow = await createLineFlow({ purpose: "login", persona: "vendor", orgId: f.org_id, jobToken, vendorMatch: "true" }, proof);
  const res = NextResponse.json({ next: `/v/liff?flow=${flow.flow}` }, { headers: privateHeaders });
  lineCookie(res, LINE_FLOW_COOKIE, flow.flow); return res;
 }
 const result = await lineTransaction(async c => {
  const { f } = await vendorMatchContextOn(c, handle, proof); rendered(f);
  const review = await vendorMatchReviewOn(c, f, b.action as "remove" | "confirm", b.jobId, b.snapshot);
  const sessionToken = cookie(request, SESSION_COOKIE), existing = await sessionOn(c, sessionToken);
  if (existing && existing.user_id !== review.userId) rejectLine(409, "account_mismatch");
  if (b.action === "remove") return { jobs: review.jobs, snapshot: review.snapshot };
  await credentialsOn(c, review.userId, { sessionToken }, false);
  const token = await lineSessionOn(c, f, review.userId, review.identityId, meta(request), sessionToken);
  // B026 portal path. B-063: /vendor-account itself is the workbench (V-HOME) when it is open for that org.
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
