import { NextResponse } from "next/server";
import { makeT } from "@/i18n";
import { lineTenantCopy } from "@/i18n/line-tenant";
import { readLineConfig } from "./config";
import { type LinePersona, LineError, liffPath } from "./login-token";
import { channelOn, flowOn, lineTransaction, randomProof, sessionOn } from "./login-link";
import { browserProof, cookie, LINE_BROWSER_COOKIE, LINE_CSRF_COOKIE, lineCookie, lineResponse, privateHeaders } from "./login-routes";

function escape(value: string) { return value.replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!); }
type Bootstrap = { liffId: string; orgId: string; csrf: string; flow: string | null; persona: LinePersona;
 purpose: string; company: string; contactId?: string };
/** Public route-group entry. No protected portal layout, provisioning, or third-party script loads. */
export function createLiffBootstrap(persona: LinePersona) {
 return (request: Request) => lineResponse(async () => {
  const url = new URL(request.url), flow = url.searchParams.get("flow");
  const locale = cookie(request, "condola_locale") === "en" ? "en" : "zh-TW";
  const t = makeT(locale), copy = lineTenantCopy(locale);
  let config: Bootstrap | null = null;
  let proof: { browser: string; csrf: string } | null = null;
  if (readLineConfig().platformEnabled) {
   try {
    if (flow) {
     proof = browserProof(request);
     config = await lineTransaction(async c => {
      const f = await flowOn(c, flow, proof!);
      if (f.persona !== persona) throw new LineError(404, "not_found");
      const channel = await channelOn(c, f.org_id, persona);
      const company = (await c.query("SELECT name FROM organizations WHERE id=$1", [f.org_id])).rows[0].name;
      return { liffId: channel.liff_id, orgId: f.org_id, csrf: proof!.csrf, flow, persona, purpose: f.kind, company };
     });
    } else {
     const org = url.searchParams.get("org");
     if (org && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(org)) {
      config = await lineTransaction(async c => {
       const channel = await channelOn(c, org, persona);
       // A mode or org hint cannot select an account, role, contact, job or property.
       let contactId: string | undefined;
       const purpose = url.searchParams.get("mode") === "manage" && persona === "tenant" ? "manage" : "login";
       if (purpose === "manage") {
        const session = await sessionOn(c, cookie(request, "condola_session"));
        if (!session) throw new LineError(401, "reauth_required");
        contactId = (await c.query(`SELECT id FROM contacts WHERE org_id=$1 AND archived_at IS NULL
         AND app.b033_contact_user(org_id,id,$2)=$3 ORDER BY id LIMIT 1`, [org, persona, session.user_id])).rows[0]?.id;
        if (!contactId) throw new LineError(404, "not_found");
       }
       const company = (await c.query("SELECT name FROM organizations WHERE id=$1", [org])).rows[0].name;
       proof = { browser: randomProof(), csrf: randomProof() };
       return { liffId: channel.liff_id, orgId: org, csrf: proof.csrf, flow: null, persona, purpose, company, contactId };
      });
     }
    }
   } catch (error) {
    // Lost cookie jars and terminal handles cannot recover private flow scope or replay it.
    if (error instanceof LineError && [401, 403, 409, 410].includes(error.status)) {
     return new NextResponse(null, { status: 303, headers: { ...privateHeaders, Location: "/login" } });
    }
    if (!(error instanceof LineError) || error.status !== 404) throw error;
   }
  }
  const confirm = config && ["invite", "bind", "manage"].includes(config.purpose);
  const form = confirm ? `<p>${escape(config!.company)}</p><form id="line-confirm" method="post" action="/api/line/bind"><label>${escape(t("i_password"))}<input name="password" type="password" autocomplete="current-password" required></label><label>${escape(t("i_mfa_code"))}<input name="secondFactor" inputmode="numeric" autocomplete="one-time-code"></label><label><input type="checkbox" name="consent" required>${escape(copy.consent)}</label><button id="line-submit" type="submit" disabled>${escape(copy.bind)}</button></form>` : "";
  const manage = config?.purpose === "manage" ? `<button id="line-unlink" type="button">${escape(copy.unlink)}</button><button id="line-revoke" type="button">${escape(copy.revoke)}</button>` : "";
  const data = config ? `<script type="application/json" id="line-bootstrap">${JSON.stringify(config).replace(/</g, "\\u003c")}</script><script src="/line-bootstrap.js" defer></script>` : "";
  const res = new NextResponse(`<!doctype html><html lang="${locale}" data-brand="v2"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="referrer" content="no-referrer"><link rel="stylesheet" href="/brand/v2/theme.css"><link rel="stylesheet" href="/line-bootstrap.css"><title>${escape(t("i_login_title"))}</title></head><body><main class="auth-wrap" data-line-entry="${liffPath(persona)}"><img class="brand" src="/brand/v2/logo/lockup_stacked_color.svg" width="200" height="148" alt="${escape(t("i_brand"))}"><div class="card pad"><h1>${escape(confirm ? copy.bind : t("i_login_title"))}</h1><a id="email-login" href="/login">${escape(copy.fallback)}</a>${form}${manage}<p id="line-status" role="status" hidden>${escape(copy.unavailable)}</p>${data}</div></main></body></html>`,
   { status: config ? 200 : 404, headers: { ...privateHeaders, "Content-Type": "text/html; charset=utf-8", "Content-Security-Policy": "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'" } });
  if (config && proof) { lineCookie(res, LINE_BROWSER_COOKIE, proof.browser); lineCookie(res, LINE_CSRF_COOKIE, proof.csrf, false); }
  return res;
 });
}
