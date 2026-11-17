import { createHash } from "node:crypto";
import { brandV2Enabled } from "./brand-v2";
import { svc } from "./db";
import { FlowError } from "./errors";

/**
 * B-065 VF-1 phase A: the signed-in vendor's self-declared issuer type (VEN-17-AC1, AC5…AC7; GS-31) through the
 * app.b065_* service-only gateways. Account session only; the company never sets it. No outbound.
 */
export const ISSUER_TYPES = ["individual", "exempt_business", "invoice_business"] as const;
export type IssuerType = typeof ISSUER_TYPES[number];
export const isIssuerType = (value: unknown): value is IssuerType => typeof value === "string" && (ISSUER_TYPES as readonly string[]).includes(value);

const hash = (credential: string) => {
  if (!credential || credential.length > 512) throw new FlowError("errors.forbidden");
  return createHash("sha256").update(credential).digest("hex");
};
const sqlState = (error: unknown) => (error as { code?: string }).code ?? (error as { cause?: { code?: string } }).cause?.code;

/** The caller's current type in this org (null: never declared). Throws FlowError("errors.forbidden") when not admitted. */
export async function vendorIssuerType(credential: string, orgId: string): Promise<IssuerType | null> {
  try {
    const raw = await svc(null, async client => (await client.query<{ r: { issuerType: unknown } }>(
      "SELECT app.b065_issuer_view($1,$2::uuid,$3) AS r", [hash(credential), orgId, brandV2Enabled()])).rows[0].r);
    return isIssuerType(raw?.issuerType) ? raw.issuerType : null;
  } catch (error) {
    if (sqlState(error) === "42501" || error instanceof FlowError) throw new FlowError("errors.forbidden");
    throw error;
  }
}

export type SaveIssuerResult = { status: "recorded"; issuerType: IssuerType; replayed: boolean }
  | { status: "unchanged"; issuerType: IssuerType } | { status: "rejected_invalid" | "rejected_conflict" };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function parseIssuerInput(value: unknown): { requestId: string; issuerType: IssuerType } | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const v = value as Record<string, unknown>;
  if (Object.keys(v).some(key => key !== "requestId" && key !== "issuerType")) return null;
  return typeof v.requestId === "string" && UUID.test(v.requestId) && isIssuerType(v.issuerType)
    ? { requestId: v.requestId, issuerType: v.issuerType } : null;
}

export async function saveVendorIssuerType(credential: string, orgId: string, input: { requestId: string; issuerType: IssuerType }): Promise<SaveIssuerResult> {
  try {
    return await svc(null, async client => (await client.query<{ r: SaveIssuerResult }>(
      "SELECT app.b065_save_issuer_type($1,$2::uuid,$3,$4::uuid,$5) AS r",
      [hash(credential), orgId, brandV2Enabled(), input.requestId, input.issuerType])).rows[0].r);
  } catch (error) {
    if (sqlState(error) === "23505") return { status: "rejected_conflict" };
    if (sqlState(error) === "42501" || error instanceof FlowError) throw new FlowError("errors.forbidden");
    throw error;
  }
}
