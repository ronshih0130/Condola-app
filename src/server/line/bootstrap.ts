import { NextResponse } from "next/server";
import { makeT } from "@/i18n";
import { readLineConfig } from "./config";
import { type LinePersona, LineError, liffPath, lineHash } from "./login-token";
import { channelOn, flowOn, lineTransaction, randomProof } from "./login-link";
import { browserProof, cookie, LINE_BROWSER_COOKIE, LINE_CSRF_COOKIE, lineCookie, lineResponse, privateHeaders } from "./login-routes";

function escape(value: string) { return value.replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!); }
/** Public route-group entry. No protected portal layout, user provisioning, or third-party script loads. */
export function createLiffBootstrap(persona: LinePersona) {
 return (request: Request) => lineResponse(async () => {
  const url = new URL(request.url), flow = url.searchParams.get("flow");
  if (persona === "vendor" && !readLineConfig().platformEnabled) throw new LineError(404, "not_found");
  const locale = cookie(request, "condola_locale") === "en" ? "en" : "zh-TW";
  const t = makeT(locale);
  let config: { liffId: string; orgId: string; csrf: string; flow: string | null; persona: LinePersona } | null = null;
  let proof: { browser: string; csrf: string } | null = null;
  if (readLineConfig().platformEnabled) {
   try {
    if (flow) {
     if (persona === "vendor") await lineTransaction(async c => {
      const f = (await c.query("SELECT org_id,persona FROM app.b033_line_flows WHERE flow_hash=$1", [lineHash(flow)])).rows[0];
      if (!f || f.persona !== "vendor") throw new LineError(404, "not_found");
      await channelOn(c, f.org_id, "vendor");
     });
     proof = browserProof(request);
     config = await lineTransaction(async c => {
      const f = await flowOn(c, flow, proof!);
      if (f.persona !== persona) throw new LineError(404, "not_found");
      const channel = await channelOn(c, f.org_id, persona);
      return { liffId: channel.liff_id, orgId: f.org_id, csrf: proof!.csrf, flow, persona };
     });
    } else {
     const org = url.searchParams.get("org");
     if (org && /^[0-9a-f-]{36}$/i.test(org)) {
      const channel = await lineTransaction(c => channelOn(c, org, persona));
      proof = { browser: randomProof(), csrf: randomProof() };
      config = { liffId: channel.liff_id, orgId: org, csrf: proof.csrf, flow: null, persona };
     }
    }
   } catch (error) {
    // Vendor OFF is a strict 404; the existing tenant/owner Email fallback stays unchanged.
    if (persona === "vendor") {
     if (error instanceof LineError && error.status === 403) return new NextResponse(null, { status: 303, headers: { ...privateHeaders, Location: "/login" } });
     throw error;
    }
    if (!(error instanceof LineError) || error.status !== 404) throw error;
   }
  }
  if (persona === "vendor" && !config) {
   const enabled = await lineTransaction(async c => (await c.query("SELECT 1 FROM organizations WHERE app.b033_portal_enabled(id,'vendor') LIMIT 1")).rowCount);
   if (!enabled) throw new LineError(404, "not_found");
  }
  const data = config ? `<script type="application/json" id="line-bootstrap">${JSON.stringify(config).replace(/</g, "\\u003c")}</script><script src="/line-bootstrap.js" defer></script>` : "";
  const res = new NextResponse(`<!doctype html><html lang="${locale}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="referrer" content="no-referrer"><title>${escape(t("i_login_title"))}</title></head><body><main data-line-entry="${liffPath(persona)}"><h1>${escape(t("i_login_title"))}</h1><a id="email-login" href="/login">${escape(t("i_login_title"))}</a>${data}</main></body></html>`,
   { headers: { ...privateHeaders, "Content-Type": "text/html; charset=utf-8", "Content-Security-Policy": "default-src 'none'; script-src 'self'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'" } });
  if (config && proof) { lineCookie(res, LINE_BROWSER_COOKIE, proof.browser); lineCookie(res, LINE_CSRF_COOKIE, proof.csrf, false); }
  return res;
 });
}
