import { createHash } from "node:crypto";
import { cache } from "react";
import { cookies, headers } from "next/headers";
import { SESSION_COOKIE } from "./auth";
import { brandV3EnabledForOrg } from "./brand-v3";
import { consentCoversCurrent, readConsent } from "./consent";
import { svc } from "./db";
import { moneyLabel } from "./format";
import { ORG_COOKIE } from "./org-scope";
import { vendorAccountHistory } from "./vendor-accounts";
import { vendorTokenAcceptable } from "./vendor-repair-rules";
import type { Locale } from "../i18n";
import type { VendorAccountHistory } from "../lib/vendor-account-types";
import { isVendorWorkbenchPath, vendorWorkbenchJobHref } from "../lib/vendor-workbench-paths";

/**
 * B-063 / VEN-14, VEN-15-AC6: the signed-in vendor workbench. Identity is the existing account session cookie
 * (B-026 / B-033 portal cookies) through the B-026 gateways; a job token is never an account credential
 * (VEN-14-AC7). The workbench exists for an organization only when its own `vendor_workbench` flag, effective
 * brand_v3 and the B-026 vendor account gate are all on. Anything else is OFF: /vendor-account stays the
 * B-026 account page byte for byte, and the /vendor-account/* routes 404.
 */

export type VendorWorkbenchScope = { orgId: string; name: string; company: string };
/** anonymous: no live account session; consent: terms not current; other: signed in, but not a vendor account; off: a vendor whose workbench is not open. */
export type VendorWorkbenchAccess =
  | { state: "on"; scope: VendorWorkbenchScope }
  | { state: "anonymous" | "consent" | "other" | "off" };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const credentialHash = (credential: string) => createHash("sha256").update(credential).digest("hex");
const denied = (error: unknown) => {
  const code = (error as { code?: string }).code ?? (error as { cause?: { code?: string } }).cause?.code;
  return code === "42501" || (error as { message?: string }).message === "errors.forbidden";
};

/**
 * Which organization the workbench shows and whether it is open there. The organization is the session's
 * current one (condola_org, set by the B-101 sign-in) when the vendor holds an account there; a vendor with
 * accounts in exactly one organization needs no cookie. More than one and no current one: OFF (OV-SH-ORG gap).
 */
export async function vendorWorkbenchAccess(credential: string | undefined, preferredOrg: string | undefined): Promise<VendorWorkbenchAccess> {
  if (!credential || credential.length > 512) return { state: "anonymous" };
  let actor: string;
  try {
    actor = await svc(null, async client => (await client.query<{ actor: string }>(
      "SELECT app.b026_account_actor($1) AS actor", [credentialHash(credential)])).rows[0].actor);
  } catch (error) {
    if (denied(error)) return { state: "anonymous" };
    throw error;
  }
  if (!consentCoversCurrent(await readConsent(actor))) return { state: "consent" };
  const history = await vendorAccountHistory(credential);
  const orgs = [...new Set(history.settings.map(item => item.orgId))];
  if (!orgs.length) return { state: "other" };
  const orgId = preferredOrg && UUID.test(preferredOrg) && orgs.includes(preferredOrg.toLowerCase()) ? preferredOrg.toLowerCase()
    : orgs.length === 1 ? orgs[0] : null;
  if (!orgId) return { state: "off" };
  const org = await svc(null, async client => (await client.query<{ open: boolean; company: string }>(
    "SELECT coalesce(feature_flags->'vendor_workbench'='true'::jsonb,false) AS open, name AS company FROM public.organizations WHERE id=$1",
    [orgId])).rows[0]);
  if (org?.open !== true || !(await brandV3EnabledForOrg(orgId))) return { state: "off" };
  const name = history.settings.find(item => item.orgId === orgId)?.name ?? "";
  return { state: "on", scope: { orgId, name: name.trim(), company: org.company } };
}

/** One account lookup per request, shared by the root layout (brand), the page and its content. */
export const currentVendorWorkbench = cache(async (): Promise<VendorWorkbenchAccess> => {
  const jar = await cookies();
  try {
    return await vendorWorkbenchAccess(jar.get(SESSION_COOKIE)?.value, jar.get(ORG_COOKIE)?.value);
  } catch {
    // A failed lookup is never a silent ON: the B-026 page (or a 404) stays.
    return { state: "off" };
  }
});

/** Root layout brand only: the vendor's organization while the workbench is open on a /vendor-account path. */
export async function vendorWorkbenchBrandOrg(): Promise<string | null> {
  let path = "";
  try { path = (await headers()).get("x-pathname") || ""; } catch { return null; }
  if (!isVendorWorkbenchPath(path)) return null;
  const access = await currentVendorWorkbench();
  return access.state === "on" ? access.scope.orgId : null;
}

export type VendorJobStatus = "visit" | "working";
export type VendorJobRow = { jobId: string; property: string; item: string; status: VendorJobStatus; href: string | null };
export type VendorPaymentRow = { jobId: string; property: string; item: string; amount: string; href: string | null };
export type VendorWorkbenchView = { status: "ready"; jobs: VendorJobRow[]; payments: VendorPaymentRow[] } | { status: "error" };
type GatewayRow = { jobId: string; property: string; currency: string | null; waitingMinor: string | null; openable: boolean };

/**
 * The existing ticket statuses that count as an open job, and the approved label each shows (V-HOME row:
 * 待到場／處理中). resolved, closed and cancelled are not open. 待估價 has no ticket status of its own and is
 * not shown (gap: it needs the B-013 estimate request state).
 */
export const OPEN_JOB_STATUS: Readonly<Record<string, VendorJobStatus>> = {
  open: "visit", triaged: "visit", assigned: "visit", in_progress: "working", on_hold: "working",
};

export function workbenchRows(history: VendorAccountHistory, gateway: GatewayRow[], orgId: string, locale: Locale) {
  const details = new Map(gateway.map(row => [row.jobId, row]));
  const jobs: VendorJobRow[] = [];
  const payments: VendorPaymentRow[] = [];
  for (const job of history.jobs) {
    // Both B-026 reads must admit the job in this organization; a job missing from either is not shown.
    const detail = details.get(job.jobId);
    if (job.orgId !== orgId || !detail) continue;
    const base = { jobId: job.jobId, property: detail.property, item: (job.description ?? "").trim(), href: detail.openable ? vendorWorkbenchJobHref(job.jobId) : null };
    const status = job.readOnly ? undefined : OPEN_JOB_STATUS[job.status];
    if (status) jobs.push({ ...base, status });
    if (detail.waitingMinor && detail.currency && /^\d+$/.test(detail.waitingMinor) && BigInt(detail.waitingMinor) > BigInt(0)) {
      payments.push({ ...base, amount: moneyLabel(detail.waitingMinor, detail.currency, locale) });
    }
  }
  return { jobs, payments };
}

/** V-HOME / V-JOBS / V-RECV rows: B-026 history (links, status, shared description) plus the B-063 gateway. */
export async function vendorWorkbenchView(credential: string, orgId: string, locale: Locale): Promise<VendorWorkbenchView> {
  try {
    const history = await vendorAccountHistory(credential);
    const gateway = await svc(null, async client => (await client.query<{ result: GatewayRow[] }>(
      "SELECT app.b063_vendor_workbench($1,$2) AS result", [credentialHash(credential), orgId])).rows[0].result);
    return { status: "ready", ...workbenchRows(history, gateway, orgId, locale) };
  } catch {
    return { status: "error" };
  }
}

/** The page's content reads the same cookie the access check used; the credential never reaches the browser. */
export async function currentVendorWorkbenchView(orgId: string, locale: Locale) {
  const credential = (await cookies()).get(SESSION_COOKIE)?.value;
  return credential ? vendorWorkbenchView(credential, orgId, locale) : { status: "error" as const };
}

/**
 * A row opens that job's existing page (/v/[token]). The admission is the same as the other workbench routes:
 * no account session (a job token alone included) → sign in; terms not current → consent; a signed-in person
 * who is not a vendor account → B1-NOPERM; workbench not open → 404. Then only a job both B-026 reads admit for
 * this account in the open workbench organization; the token is read server-side and only for that one job.
 */
export type VendorJobOpen = { state: "open"; token: string } | { state: "login" | "consent" | "noperm" | "missing" };
export async function vendorWorkbenchJobOpen(credential: string | undefined, preferredOrg: string | undefined, jobId: string): Promise<VendorJobOpen> {
  const access = await vendorWorkbenchAccess(credential, preferredOrg).catch(() => ({ state: "off" as const }));
  if (access.state === "anonymous") return { state: "login" };
  if (access.state === "consent") return { state: "consent" };
  if (access.state === "other") return { state: "noperm" };
  if (access.state !== "on" || !credential || !UUID.test(jobId)) return { state: "missing" };
  const view = await vendorWorkbenchView(credential, access.scope.orgId, "zh-TW");
  if (view.status !== "ready" || ![...view.jobs, ...view.payments].some(row => row.jobId === jobId.toLowerCase() && row.href)) return { state: "missing" };
  const token = await svc(null, async client => (await client.query<{ token: string }>(
    `SELECT s.token FROM public.repair_vendor_secrets s JOIN public.repair_vendor_jobs j ON j.id=s.job_id
      WHERE s.job_id=$1 AND j.org_id=$2`, [jobId.toLowerCase(), access.scope.orgId])).rows[0]?.token);
  return token && vendorTokenAcceptable(token.trim()) ? { state: "open", token: token.trim() } : { state: "missing" };
}

export function cookieFrom(request: Request, name: string) {
  return request.headers.get("cookie")?.split(";").map(part => part.trim()).find(part => part.startsWith(`${name}=`))?.slice(name.length + 1);
}
