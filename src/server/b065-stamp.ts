import { createHash } from "node:crypto";
import { brandV2Enabled } from "./brand-v2";
import { svc } from "./db";
import { FlowError } from "./errors";
import { hashVendorToken } from "./vendor-repair-rules";

/**
 * B-065 phase B slice P1 (VEN-18-AC6, AC9, AC10 data layer): the vendor's direction-1 receipt stamp versions and their
 * consent, through the service-only app.b065_* gateways (migration 20261118110000_b065_stamp.sql). Two admissions,
 * both verified on the server: the B-026 account session (ven-stamp, login only) and the B-025 document token
 * (B-067's receipt flow on /v/documents/[token]). No route, page or generator here (P2). No outbound.
 */
export const STAMP_CONSENT_TEXT = "我同意使用這枚印章開立收據";
export const STAMP_SVG_MAX_BYTES = 524288;
export const STAMP_READINESS = ["needs_tax_id", "needs_stamp", "stale", "needs_consent", "ready"] as const;
export type StampReadiness = typeof STAMP_READINESS[number];
export const STAMP_STATES = ["none", "generated", "consented", "stale"] as const;
export type StampState = typeof STAMP_STATES[number];

/** The printed inputs exactly as app.b065_stamp_inputs defines them (the only definition; never rebuilt here). */
export type StampInputs = { name: string | null; tax_id: string | null; representative: string | null; address: string | null; phone_e164: string | null };
export type StampArt = { version: number; source: "generated" | "uploaded"; sha256: string; svg: string | null; sealId: string | null; consented: boolean; createdAt: string };
export type StampView = { state: StampState; status: StampReadiness; inputs: StampInputs | null; inputsSha256: string | null; inputsFit: boolean;
  current: StampArt | null; consents: Array<{ version: number; source: "generated" | "uploaded"; sha256: string; kind: "consented" | "adopted_upload"; consentedAt: string }> };
export type StampPreview = { status: StampReadiness; inputs: StampInputs | null; inputsSha256: string | null; inputsFit: boolean; latest: StampArt | null };
export type ReceiptStamp = { status: StampReadiness; inputsSha256: string | null;
  stamp: { versionId: string; version: number; source: "generated" | "uploaded"; sha256: string; consentRequestId: string | null } | null };

export type StampArtInput = { svg: string; inputsSha256: string; fontId: string; generatorVersion: string; fallbackCodepoints: number[] };
export type SaveStampInput = { requestId: string } & StampArtInput;
export type ConsentStampInput = { requestId: string; previewedSha256: string; art: StampArtInput | null };
export type StampWriteResult =
  | { status: "recorded" | "unchanged" | "consented"; version: number; sha256: string; replayed: boolean }
  | { status: "rejected_invalid"; reason?: "needs_tax_id" | "stamp_input_limit" }
  | { status: "rejected_stale" | "rejected_superseded" | "rejected_conflict" | "busy" };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SHA256 = /^[0-9a-f]{64}$/;
const FONT_ID = /^[A-Za-z0-9][A-Za-z0-9._@+-]{0,127}$/;
const GENERATOR = /^[A-Za-z0-9][A-Za-z0-9._@+-]{0,63}$/;
const SVG_ELEMENTS = new Set(["svg", "g", "rect", "path"]);
const SVG_ATTRIBUTES = new Set(["xmlns", "viewBox", "width", "height", "x", "y", "rx", "ry", "d", "fill", "stroke", "stroke-width", "fill-rule", "transform"]);
const TAG = /<(\/?)([A-Za-z][A-Za-z0-9-]*)((?:\s+[A-Za-z][A-Za-z0-9:-]*="[^"<>&]*")*)\s*(\/?)>/g;
const ATTRIBUTE = /([A-Za-z][A-Za-z0-9:-]*)="([^"<>&]*)"/g;

export const stampSha256 = (svg: string) => createHash("sha256").update(svg, "utf8").digest("hex");

/**
 * Canonical stamp art: an <svg> root in the SVG namespace with only svg/g/rect/path elements and presentation
 * attributes, balanced, no text nodes, entities, references, styles, scripts or event handlers, at most 512 KiB.
 * Stricter than (and implies) the database's app.b065_svg_canonical check.
 */
export function parseStampSvg(value: unknown): string | null {
  if (typeof value !== "string" || !value.startsWith('<svg xmlns="http://www.w3.org/2000/svg"') || !value.endsWith("</svg>")) return null;
  if (Buffer.byteLength(value, "utf8") > STAMP_SVG_MAX_BYTES) return null;
  if (/&|href|url\s*\(|\son[a-z]+\s*=|style|script|<!|<\?|\\/i.test(value)) return null;
  const stack: string[] = [];
  let at = 0, roots = 0;
  for (const match of value.matchAll(TAG)) {
    if (value.slice(at, match.index).trim() !== "") return null;
    at = match.index + match[0].length;
    const [, closing, name, attributes, selfClosing] = match;
    if (!SVG_ELEMENTS.has(name)) return null;
    if (closing) {
      if (attributes || selfClosing || stack.pop() !== name) return null;
      continue;
    }
    if ((name === "svg") !== (stack.length === 0)) return null;
    if (stack.length === 0 && ++roots > 1) return null;
    const seen = new Set<string>();
    for (const [, attribute] of attributes.matchAll(ATTRIBUTE)) {
      if (!SVG_ATTRIBUTES.has(attribute) || seen.has(attribute)) return null;
      seen.add(attribute);
    }
    if (!selfClosing) stack.push(name);
  }
  return at === value.length && stack.length === 0 && roots === 1 ? value : null;
}

function parseFallback(value: unknown): number[] | null {
  if (!Array.isArray(value) || value.length > 160) return null;
  let previous = -1;
  for (const cp of value) {
    if (!Number.isInteger(cp) || cp <= previous || cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff)) return null;
    previous = cp;
  }
  return value as number[];
}

const ART_KEYS = ["svg", "inputsSha256", "fontId", "generatorVersion", "fallbackCodepoints"] as const;
function parseArt(v: Record<string, unknown>): StampArtInput | null {
  const svg = parseStampSvg(v.svg), fallback = parseFallback(v.fallbackCodepoints);
  if (svg === null || fallback === null || typeof v.inputsSha256 !== "string" || !SHA256.test(v.inputsSha256)
    || typeof v.fontId !== "string" || !FONT_ID.test(v.fontId) || typeof v.generatorVersion !== "string" || !GENERATOR.test(v.generatorVersion)) return null;
  return { svg, inputsSha256: v.inputsSha256, fontId: v.fontId, generatorVersion: v.generatorVersion, fallbackCodepoints: fallback };
}
const record = (value: unknown, keys: readonly string[]) => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const v = value as Record<string, unknown>;
  return Object.keys(v).every(key => keys.includes(key)) ? v : null;
};

/** 「產生印章」/「重新產生」: a uuid request id and the generated art with its generator metadata; no other keys. */
export function parseSaveStampInput(value: unknown): SaveStampInput | null {
  const v = record(value, ["requestId", ...ART_KEYS]);
  if (!v || typeof v.requestId !== "string" || !UUID.test(v.requestId)) return null;
  const art = parseArt(v);
  return art ? { requestId: v.requestId, ...art } : null;
}

/**
 * 「使用這枚印章並繼續」: the previewed art's sha256, and either no art (consent to the stored latest version) or the whole
 * art (stateless preview: appended and consented), whose recomputed sha256 must be the previewed one.
 */
export function parseConsentStampInput(value: unknown): ConsentStampInput | null {
  const v = record(value, ["requestId", "previewedSha256", ...ART_KEYS]);
  if (!v || typeof v.requestId !== "string" || !UUID.test(v.requestId) || typeof v.previewedSha256 !== "string" || !SHA256.test(v.previewedSha256)) return null;
  const present = ART_KEYS.filter(key => key in v);
  if (present.length === 0) return { requestId: v.requestId, previewedSha256: v.previewedSha256, art: null };
  const art = present.length === ART_KEYS.length ? parseArt(v) : null;
  return art && stampSha256(art.svg) === v.previewedSha256 ? { requestId: v.requestId, previewedSha256: v.previewedSha256, art } : null;
}

const sqlState = (error: unknown) => (error as { code?: string }).code ?? (error as { cause?: { code?: string } }).cause?.code;
/** Admission refused in the gateway (42501, which svc wraps with the code on `cause`) or a credential rejected here. */
const refusal = (error: unknown) => sqlState(error) === "42501" || (error instanceof FlowError && error.key === "errors.forbidden");
const sessionHash = (credential: string) => {
  if (!credential || credential.length > 512) throw new FlowError("errors.forbidden");
  return createHash("sha256").update(credential).digest("hex");
};
/** A document link's grant scope as B-067 resolved it; the gateway re-admits it from the token's hash. */
export type StampGrantScope = { token: string; orgId: string; profileId: string };
const tokenHash = (token: string) => {
  if (typeof token !== "string" || !/^[A-Za-z0-9_-]{32,256}$/.test(token.trim())) throw new FlowError("errors.forbidden");
  return hashVendorToken(token);
};

async function read<T>(sql: string, params: () => unknown[]): Promise<T> {
  try {
    return await svc(null, async client => (await client.query<{ r: T }>(sql, params())).rows[0].r);
  } catch (error) {
    if (refusal(error)) throw new FlowError("errors.forbidden");
    throw error;
  }
}
async function write(sql: string, params: () => unknown[]): Promise<StampWriteResult> {
  try {
    return await svc(null, async client => (await client.query<{ r: StampWriteResult }>(sql, params())).rows[0].r);
  } catch (error) {
    const code = sqlState(error);
    if (code === "55P03" || code === "40P01" || code === "57014") return { status: "busy" };
    if (code === "23505") return { status: "rejected_conflict" };
    if (refusal(error)) throw new FlowError("errors.forbidden");
    throw error;
  }
}
const art = (a: StampArtInput | null) => a ? [a.svg, a.inputsSha256, a.fontId, a.generatorVersion, a.fallbackCodepoints] : [null, null, null, null, null];

/** ven-stamp (account session only). Throws FlowError("errors.forbidden") unless admitted (type 2, gates on). */
export const vendorStampView = (credential: string, orgId: string) => read<StampView>(
  "SELECT app.b065_stamp_view($1,$2::uuid,$3) AS r", () => [sessionHash(credential), orgId, brandV2Enabled()]);
/** Advisory readiness for UI routing; B-067's freeze transaction re-evaluates it under its locks. */
export const vendorReceiptStamp = (credential: string, orgId: string) => read<ReceiptStamp>(
  "SELECT app.b065_receipt_stamp($1,$2::uuid,$3) AS r", () => [sessionHash(credential), orgId, brandV2Enabled()]);
export const saveVendorStamp = (credential: string, orgId: string, input: SaveStampInput) => write(
  "SELECT app.b065_save_stamp($1,$2::uuid,$3,$4::uuid,$5,$6,$7,$8,$9::integer[]) AS r",
  () => [sessionHash(credential), orgId, brandV2Enabled(), input.requestId, ...art(input)]);
export const consentVendorStamp = (credential: string, orgId: string, input: ConsentStampInput) => write(
  "SELECT app.b065_consent_stamp($1,$2::uuid,$3,$4::uuid,$5,$6,$7,$8,$9,$10::integer[]) AS r",
  () => [sessionHash(credential), orgId, brandV2Enabled(), input.requestId, input.previewedSha256, ...art(input.art)]);

/** B-067's grant-scoped preview read (S8): readiness, canonical inputs and the admitted vendor's latest art. */
export const stampPreviewByGrant = (scope: StampGrantScope) => read<StampPreview>(
  "SELECT app.b065_stamp_preview_by_grant($1,$2::uuid,$3::uuid) AS r", () => [tokenHash(scope.token), scope.orgId, scope.profileId]);
export const receiptStampByGrant = (scope: StampGrantScope) => read<ReceiptStamp>(
  "SELECT app.b065_receipt_stamp_by_grant($1,$2::uuid,$3::uuid) AS r", () => [tokenHash(scope.token), scope.orgId, scope.profileId]);
export const saveStampByGrant = (scope: StampGrantScope, input: SaveStampInput) => write(
  "SELECT app.b065_save_stamp_by_grant($1,$2::uuid,$3::uuid,$4::uuid,$5,$6,$7,$8,$9::integer[]) AS r",
  () => [tokenHash(scope.token), scope.orgId, scope.profileId, input.requestId, ...art(input)]);
export const consentStampByGrant = (scope: StampGrantScope, input: ConsentStampInput) => write(
  "SELECT app.b065_consent_stamp_by_grant($1,$2::uuid,$3::uuid,$4::uuid,$5,$6,$7,$8,$9,$10::integer[]) AS r",
  () => [tokenHash(scope.token), scope.orgId, scope.profileId, input.requestId, input.previewedSha256, ...art(input.art)]);
