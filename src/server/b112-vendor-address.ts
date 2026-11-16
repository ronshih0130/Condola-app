import { createHash } from "node:crypto";
import { brandV2Enabled } from "./brand-v2";
import { svc } from "./db";
import { FlowError } from "./errors";

/**
 * B-112 VEN-ADDR (ven-addr-confirm; VEN-18-AC5, AC6, VEN-17-AC6). A signed-in vendor types one address line in
 * 我的帳號; on 儲存 the line is split into 縣市 / 鄉鎮市區 / 街道 / 門牌 for them to confirm, and only the confirm
 * sheet's 儲存 writes. The confirmed parts are joined back into the existing one-line vendor_profiles.address.
 * Admission is the B-026 account session through app.b112_* (never a job or document token). No outbound.
 */

import { joinTwAddress, validateAddressParts, type AddressParts } from "../lib/tw-address";
export { joinTwAddress, parseTwAddress, validateAddressParts, TW_CITIES, type AddressParts } from "../lib/tw-address";

const hash = (credential: string) => {
  if (!credential || credential.length > 512) throw new FlowError("errors.forbidden");
  return createHash("sha256").update(credential).digest("hex");
};
function sqlState(error: unknown) {
  return (error as { code?: string }).code ?? (error as { cause?: { code?: string } }).cause?.code;
}

export type VendorAddressView = { profileId: string; version: number; kind: "business" | "individual"; address: string | null };
/** null: this vendor has no profile in the org yet (the card is not shown). Throws FlowError when not admitted. */
export async function vendorAddressView(credential: string, orgId: string): Promise<VendorAddressView | null> {
  try {
    const raw = await svc(null, async client => (await client.query<{ r: VendorAddressView | null }>(
      "SELECT app.b112_vendor_address($1,$2::uuid,$3) AS r", [hash(credential), orgId, brandV2Enabled()])).rows[0].r);
    return raw;
  } catch (error) {
    if (sqlState(error) === "42501" || error instanceof FlowError) throw new FlowError("errors.forbidden");
    throw error;
  }
}

export type SaveAddressInput = { requestId: string; expectedVersion: number; parts: AddressParts };
export type SaveAddressResult = { status: "recorded"; version: number; address: string; replayed: boolean }
  | { status: "unchanged"; version: number; address: string }
  | { status: "rejected_invalid" | "rejected_stale" | "rejected_conflict" };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function parseSaveInput(value: unknown): SaveAddressInput | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const v = value as Record<string, unknown>;
  const p = v.parts as Record<string, unknown> | undefined;
  if (typeof v.requestId !== "string" || !UUID.test(v.requestId) || !Number.isSafeInteger(v.expectedVersion)
    || (v.expectedVersion as number) < 1 || !p || typeof p !== "object") return null;
  const parts = { city: p.city, district: p.district ?? "", street: p.street ?? "", number: p.number ?? "" };
  if (Object.values(parts).some(x => typeof x !== "string" || x.length > 200)) return null;
  const clean = Object.fromEntries(Object.entries(parts).map(([k, x]) => [k, (x as string).trim()])) as AddressParts;
  if (validateAddressParts(clean).length) return null;
  return { requestId: v.requestId, expectedVersion: v.expectedVersion as number, parts: clean };
}

export async function saveVendorAddress(credential: string, orgId: string, input: SaveAddressInput): Promise<SaveAddressResult> {
  try {
    return await svc(null, async client => (await client.query<{ r: SaveAddressResult }>(
      "SELECT app.b112_save_vendor_address($1,$2::uuid,$3,$4::uuid,$5,$6) AS r",
      [hash(credential), orgId, brandV2Enabled(), input.requestId, input.expectedVersion, joinTwAddress(input.parts)])).rows[0].r);
  } catch (error) {
    if (sqlState(error) === "42501" || error instanceof FlowError) throw new FlowError("errors.forbidden");
    throw error;
  }
}
