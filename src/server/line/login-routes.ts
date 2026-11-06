import { LINE_JOB_COOKIE } from "./vendor-scope";
import { NextResponse } from "next/server";
import { sessionCookie, SESSION_COOKIE } from "../auth";
import { readLineConfig } from "./config";
import { resolveLocalLineSecret } from "./secrets";
import type { SecretResolver } from "./webhook";
import { LineError, rejectLine, liffPath, type LinePersona } from "./login-token";
import { acceptLineLink, callbackLineLogin, createLineFlow, exchangeLineSession, flowOn, lineTransaction,
 listLineLinks, revokeLineIdentity, startLineLogin, stepUpLine, unlinkLine, type BrowserProof, type LineCodeExchange } from "./login-link";

export const LINE_BROWSER_COOKIE = "condola_line_browser";
export const LINE_CSRF_COOKIE = "condola_line_csrf";
export const LINE_FLOW_COOKIE = "condola_line_flow";
export const LINE_PKCE_COOKIE = "condola_line_pkce";
export const privateHeaders = { "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" };
export function cookie(request: Request, name: string) {
 const parts = (request.headers.get("cookie") ?? "").split(";").map(p => p.trim());
 const values = parts.filter(p => p.startsWith(`${name}=`));
 if (values.length !== 1) return undefined;
 try { return decodeURIComponent(values[0].slice(name.length + 1)); } catch { return undefined; }
}
export function browserProof(request: Request): BrowserProof {
 const browser = cookie(request, LINE_BROWSER_COOKIE), csrf = cookie(request, LINE_CSRF_COOKIE);
 if (!browser || !csrf || !/^[\w-]{43}$/.test(browser) || !/^[\w-]{43}$/.test(csrf)) rejectLine(403, "csrf");
 return { browser, csrf };
}
export function lineCookie(response: NextResponse, name: string, value: string, httpOnly = true) {
 response.cookies.set(name, value, { secure: true, httpOnly, sameSite: "lax", path: "/", maxAge: 300 });
}
function response(body: unknown, status = 200, token?: string) {
 const res = NextResponse.json(body, { status, headers: privateHeaders });
 if (token) { const c = sessionCookie(token, false); res.cookies.set(c.name, c.value, { ...c.options, secure: true }); }
 return res;
}
export async function lineResponse(work: () => Promise<Response>) {
 try { return await work(); }
 catch (error) { return error instanceof LineError ? response({ error: error.code }, error.status) : response({ error: "line_unavailable" }, 503); }
}
export function envGate() { if (!readLineConfig().platformEnabled) rejectLine(404, "not_found"); }
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export async function body(request: Request) {
 if (!request.headers.get("content-type")?.startsWith("application/json")) rejectLine(400, "invalid_request");
 const raw = await request.text();
 if (raw.length > 16000) rejectLine(400, "invalid_request");
 let value: Record<string, unknown>;
 try { value = JSON.parse(raw); } catch { return rejectLine(400, "invalid_request"); }
 if (!value || typeof value !== "object" || Array.isArray(value)) rejectLine(400, "invalid_request");
 for (const [key, val] of Object.entries(value)) {
  if (typeof val !== "string" || val.length > (key === "idToken" ? 8192 : 1000)) rejectLine(400, "invalid_request");
  if (["orgId", "contactId", "identityId"].includes(key) && !uuid.test(val)) rejectLine(400, "invalid_request");
 }
 return value as Record<string, string>;
}
export function csrfCheck(request: Request, proof: BrowserProof, csrf: string | undefined) {
 if (request.headers.get("origin") !== new URL(request.url).origin || !csrf || csrf !== proof.csrf
  || (request.headers.get("sec-fetch-site") && !["same-origin", "none"].includes(request.headers.get("sec-fetch-site")!))) rejectLine(403, "csrf");
}
function auth(request: Request, input: Record<string, string> = {}) {
 return { sessionToken: cookie(request, SESSION_COOKIE), email: input.email, password: input.password, secondFactor: input.secondFactor };
}
function meta(request: Request) { return { ua: request.headers.get("user-agent"), ip: null }; }
export function createLineHandlers(deps: { resolveSecret?: SecretResolver; exchangeCode?: LineCodeExchange } = {}) {
 const resolve = deps.resolveSecret ?? resolveLocalLineSecret;
 const exchange = deps.exchangeCode ?? (async () => rejectLine(503, "line_unavailable"));
 return {
  reauth: (request: Request) => lineResponse(async () => {
   envGate(); const b = await body(request), proof = browserProof(request);
   if (!b.orgId || !["tenant", "owner", "vendor"].includes(b.persona)) rejectLine(400, "invalid_request");
   csrfCheck(request, proof, b.csrf);
   return response(await stepUpLine({ ...auth(request, b), orgId: b.orgId, persona: b.persona as LinePersona }));
  }),
  flows: (request: Request) => lineResponse(async () => {
   envGate(); const b = await body(request), proof = browserProof(request);
   if (!["login", "invite", "bind", "unlink"].includes(b.purpose)) rejectLine(400, "invalid_request");
   if (b.persona && !["tenant", "owner", "vendor"].includes(b.persona)) rejectLine(400, "invalid_request");
   csrfCheck(request, proof, b.csrf);
   const result = await createLineFlow({ ...b, purpose: b.purpose as "login" | "invite" | "bind" | "unlink",
    persona: b.persona as LinePersona, sessionToken: cookie(request, SESSION_COOKIE) }, proof);
   return response({ flow: result.flow, expiresAt: result.expiresAt, liffUrl: `${liffPath(result.persona)}?flow=${encodeURIComponent(result.flow)}` }, 201);
  }),
  start: (request: Request) => lineResponse(async () => {
   envGate(); const url = new URL(request.url), proof = browserProof(request), handle = url.searchParams.get("flow") ?? "";
   const result = await startLineLogin(handle, proof, url.origin);
   const res = new NextResponse(null, { status: 302, headers: { ...privateHeaders, Location: result.url } });
   lineCookie(res, LINE_FLOW_COOKIE, handle); lineCookie(res, LINE_PKCE_COOKIE, result.verifier); return res;
  }),
  callback: (request: Request) => lineResponse(async () => {
   envGate(); const url = new URL(request.url), proof = browserProof(request);
   const result = await callbackLineLogin({ flow: cookie(request, LINE_FLOW_COOKIE) ?? "", state: url.searchParams.get("state") ?? "",
    verifier: cookie(request, LINE_PKCE_COOKIE) ?? "", code: url.searchParams.get("code") ?? undefined,
    error: url.searchParams.get("error") ?? undefined, origin: url.origin }, proof, resolve, exchange, meta(request), auth(request));
   const res = new NextResponse(null, { status: 303, headers: { ...privateHeaders, Location: new URL(result.next, url.origin).toString() } });
   if ("token" in result && result.token) { const co = sessionCookie(result.token, false); res.cookies.set(co.name, co.value, { ...co.options, secure: true }); }
   if ("jobClaim" in result) lineCookie(res, LINE_JOB_COOKIE, result.jobClaim);
   res.cookies.set(LINE_PKCE_COOKIE, "", { path: "/", maxAge: 0 }); return res;
  }),
  session: (request: Request) => lineResponse(async () => {
   envGate(); const b = await body(request), proof = browserProof(request);
   await lineTransaction(c => flowOn(c, b.flow ?? "", proof)); // portal OFF precedes CSRF and all writes
   csrfCheck(request, proof, b.csrf);
   const result = await exchangeLineSession(b.flow ?? "", proof, b.idToken ?? "", resolve, meta(request), auth(request, b));
   if ("jobClaim" in result) { const res = response({ next: result.next }); lineCookie(res, LINE_JOB_COOKIE, result.jobClaim); return res; }
   return "token" in result ? response({ next: result.next }, 200, result.token) : response(result);
  }),
  bind: (request: Request) => link(request, "bind"),
  accept: (request: Request) => link(request, "invite"),
  links: (request: Request) => lineResponse(async () => { envGate(); return response(await listLineLinks(cookie(request, SESSION_COOKIE))); }),
  unlink: (request: Request, id: string) => lineResponse(async () => {
   envGate(); const b = await body(request), proof = browserProof(request); csrfCheck(request, proof, b.csrf);
   if (!uuid.test(id)) rejectLine(404, "not_found");
   return response(await unlinkLine(id, cookie(request, SESSION_COOKIE), b.reason ?? ""));
  }),
  revoke: (request: Request) => lineResponse(async () => {
   envGate(); const b = await body(request), proof = browserProof(request); csrfCheck(request, proof, b.csrf);
   return response(await revokeLineIdentity(cookie(request, SESSION_COOKIE), b.identityId));
  }),
 };
 function link(request: Request, purpose: "bind" | "invite") {
  return lineResponse(async () => {
   envGate(); const b = await body(request), proof = browserProof(request);
   await lineTransaction(c => flowOn(c, b.flow ?? "", proof)); csrfCheck(request, proof, b.csrf);
   const result = await acceptLineLink({ ...b, flow: b.flow ?? "", ...auth(request, b) }, proof, resolve, meta(request), purpose);
   return response(purpose === "bind" ? { linkId: result.linkId, status: result.status } : { next: result.next, linkId: result.linkId }, 200, result.token);
  });
 }
}
export const lineHandlers = createLineHandlers();
