import { brandV2Enabled } from "./brand-v2";
import { svc } from "./db";
import { hashVendorToken, vendorTokenAcceptable } from "./vendor-repair-rules";

/**
 * B-098 VEN-PHONE (VEN-27-AC3): the reporting tenant's phone for 「打電話給租客」, only for the assigned vendor's live,
 * accepted B-105 case bearer while the case is open (app.b098_vendor_tenant_phone, behind vendor_job_v3). Never
 * after close, never for another vendor, a revoked or expired link, a document token or a share link.
 *
 * null: not shown (not admitted, closed, not accepted). { phone: null }: admitted, but no tenant phone on file.
 */
const E164 = /^\+[1-9]\d{6,14}$/;
export async function vendorTenantPhone(token: string): Promise<{ phone: string | null } | null> {
  if (!vendorTokenAcceptable(token)) return null;
  const raw = await svc(null, async client => (await client.query<{ r: { phone?: unknown } | null }>(
    "SELECT app.b098_vendor_tenant_phone($1,$2) AS r", [hashVendorToken(token), brandV2Enabled()])).rows[0]?.r ?? null);
  if (!raw || typeof raw !== "object") return null;
  return { phone: typeof raw.phone === "string" && E164.test(raw.phone) ? raw.phone : null };
}
