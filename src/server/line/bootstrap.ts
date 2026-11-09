import { NextResponse } from "next/server";
import { SESSION_COOKIE } from "../auth";
import { linePortalChoices } from "./portal";
import { makeT } from "@/i18n";
import { lineTenantCopy } from "@/i18n/line-tenant";
import { readLineConfig } from "./config";
import { type LinePersona, LineError, liffPath, lineHash } from "./login-token";
import { channelOn, flowOn, lineTransaction, randomProof, sessionOn } from "./login-link";
import { browserProof, cookie, LINE_BROWSER_COOKIE, LINE_CSRF_COOKIE, lineCookie, lineResponse, privateHeaders } from "./login-routes";

function escape(value: string) { return value.replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!); }
type Bootstrap = { liffId: string; orgId: string; csrf: string; flow: string | null; persona: LinePersona;
 purpose?: string; company?: string; contactId?: string; verified?: boolean };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const toLogin = () => new NextResponse(null, { status: 303, headers: { ...privateHeaders, Location: "/login" } });
/**
 * Public route-group entry. No protected portal layout, provisioning, or third-party script loads.
 * Each portal keeps its own reviewed contract: tenant B-034 (binding/manage page, lost-cookie 303),
 * vendor B-035 (strict OFF, generic Email guidance, lost-cookie 303), owner B-036 (plain entry + existing-session role chooser).
 * OFF, missing or malformed gates return 404 with the Email link and no cookies or writes.
 */
export function createLiffBootstrap(persona: LinePersona) {
 return (request: Request) => lineResponse(async () => {
  const url = new URL(request.url), flow = url.searchParams.get("flow");
  const platform = readLineConfig().platformEnabled;
  const locale = cookie(request, "condola_locale") === "en" ? "en" : "zh-TW";
  const t = makeT(locale);
  let config: Bootstrap | null = null, denied = false;
  let proof: { browser: string; csrf: string } | null = null;
  if (platform) {
   try {
    if (flow) {
     // Vendor gates are checked before the browser proof is read (B-035 strict OFF order).
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
      const base = { liffId: channel.liff_id, orgId: f.org_id, csrf: proof!.csrf, flow, persona, verified: Boolean(f.verified_hash) };
      if (persona === "vendor") return base;
      const company = (await c.query("SELECT name FROM organizations WHERE id=$1", [f.org_id])).rows[0].name;
      return { ...base, purpose: f.kind, company };
     });
    } else {
     const org = url.searchParams.get("org");
     if (org && UUID.test(org)) {
      config = await lineTransaction(async c => {
       const channel = await channelOn(c, org, persona);
       if (persona !== "tenant") {
        proof = { browser: randomProof(), csrf: randomProof() };
        return { liffId: channel.liff_id, orgId: org, csrf: proof.csrf, flow: null, persona };
       }
       // A mode or org hint cannot select an account, role, contact, job or property.
       let contactId: string | undefined;
       const purpose = url.searchParams.get("mode") === "manage" ? "manage" : "login";
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
    // Lost cookie jars and terminal handles cannot recover private flow scope or replay it (tenant B-034, vendor B-035).
    if (error instanceof LineError && (persona === "tenant" ? [401, 403, 409, 410].includes(error.status) : persona === "vendor" && error.status === 403)) return toLogin();
    if (!(error instanceof LineError) || error.status !== 404) throw error;
    config = null; proof = null; denied = true;
   }
  }
  // Vendor generic entry (no flow/org hint) offers Email guidance only while some vendor portal is ON (B-035).
  const vendorGeneric = persona === "vendor" && platform && !config && !denied
   && Boolean(await lineTransaction(async c => (await c.query("SELECT 1 FROM organizations WHERE app.b033_portal_enabled(id,'vendor') LIMIT 1")).rowCount));
  const status = config || vendorGeneric ? 200 : 404;
  const data = config ? `<script type="application/json" id="line-bootstrap">${JSON.stringify(config).replace(/</g, "\\u003c")}</script><script src="/line-bootstrap.js" defer></script>` : "";
  let html: string, csp: string;
  if (persona === "tenant" || (persona === "owner" && config?.purpose === "invite")) {
   const copy = lineTenantCopy(locale);
   const confirm = config && ["invite", "bind", "manage"].includes(config.purpose ?? "");
   const form = confirm ? `<p>${escape(config!.company ?? "")}</p><form id="line-confirm" method="post" action="/api/line/bind"><label>${escape(t("i_password"))}<input name="password" type="password" autocomplete="current-password" required></label><label>${escape(t("i_mfa_code"))}<input name="secondFactor" inputmode="numeric" autocomplete="one-time-code"></label><label><input type="checkbox" name="consent" required>${escape(copy.consent)}</label><button id="line-submit" type="submit" disabled>${escape(copy.bind)}</button></form>` : "";
   const manage = config?.purpose === "manage" ? `<button id="line-unlink" type="button">${escape(copy.unlink)}</button><button id="line-revoke" type="button">${escape(copy.revoke)}</button>` : "";
   html = `<!doctype html><html lang="${locale}" data-brand="v2"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="referrer" content="no-referrer"><link rel="stylesheet" href="/brand/v2/theme.css"><link rel="stylesheet" href="/line-bootstrap.css"><title>${escape(t("i_login_title"))}</title></head><body><main class="auth-wrap" data-line-entry="${liffPath(persona)}"><img class="brand" src="/brand/v2/logo/lockup_stacked_color.svg" width="200" height="148" alt="${escape(t("i_brand"))}"><div class="card pad"><h1>${escape(confirm ? copy.bind : t("i_login_title"))}</h1><a id="email-login" href="/login">${escape(copy.fallback)}</a>${form}${manage}<p id="line-status" role="status" hidden>${escape(copy.unavailable)}</p>${data}</div></main></body></html>`;
   csp = "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'";
  } else {
   // B-036 owner chooser: existing-session roles only; POST /api/line/portal rechecks each selection.
   const choices = persona === "owner" && config ? await linePortalChoices(cookie(request, SESSION_COOKIE)) : [];
   const picker = choices.map(choice => `<button type="button" data-line-portal="${choice.persona}" data-line-org="${choice.orgId}">${escape(choice.name)} · ${escape(t(choice.persona === "owner" ? "i_mode_own" : choice.persona === "tenant" ? "i_mode_ten" : "i_expense_vendor"))}</button>`).join("");
   html = `<!doctype html><html lang="${locale}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="referrer" content="no-referrer"><title>${escape(t("i_login_title"))}</title></head><body><main data-line-entry="${liffPath(persona)}"><h1>${escape(t("i_login_title"))}</h1><a id="email-login" href="/login">${escape(t("i_login_title"))}</a>${picker}${data}</main></body></html>`;
   csp = "default-src 'none'; script-src 'self'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'";
  }
  const res = new NextResponse(html, { status, headers: { ...privateHeaders, "Content-Type": "text/html; charset=utf-8", "Content-Security-Policy": csp } });
  if (config && proof) { lineCookie(res, LINE_BROWSER_COOKIE, proof.browser); lineCookie(res, LINE_CSRF_COOKIE, proof.csrf, false); }
  return res;
 });
}
