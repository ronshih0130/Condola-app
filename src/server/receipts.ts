import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import type { Client } from "pg";
import { one, tx } from "./db";
import { FlowError } from "./errors";
import { can } from "./perms";
import {
  RECEIPT_BUCKET,
  RECEIPT_HEADER_BYTES,
  acceptReceiptObject,
  assertReceiptMeta,
  isReceiptPath,
  receiptFileId,
  receiptPath,
  receiptPaths,
  type ReceiptClaim,
  type ReceiptMime,
} from "./receipt-rules";
import type { Session } from "./types";

/**
 * Receipts live in a private bucket and move through signed URLs.
 * Confirm reads the first bytes to check the signature, then cancels the rest.
 * The Worker does not decode or re-encode the file.
 */

type StorageConfig = { url: string; key: string };

function storageConfig(): StorageConfig | null {
  const url = (process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL || "").replace(/\/$/, "");
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY || "";
  if (!url || !key) return null;
  return { url, key };
}

function absoluteStorageUrl(base: string, path: string) {
  if (path.startsWith("http://") || path.startsWith("https://")) return path;
  const suffix = path.startsWith("/") ? path : `/${path}`;
  if (suffix.startsWith("/storage/")) return `${base}${suffix}`;
  return `${base}/storage/v1${suffix}`;
}

async function storageRequest(method: string, path: string, body?: unknown) {
  const cfg = storageConfig();
  if (!cfg) throw new FlowError("errors.receiptStorage");
  const response = await fetch(`${cfg.url}/storage/v1${path}`, {
    method,
    cache: "no-store",
    headers: {
      authorization: `Bearer ${cfg.key}`,
      apikey: cfg.key,
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return response;
}

export type ReceiptKind = "expense" | "payment";

function assertCanUpload(session: Session, kind: ReceiptKind) {
  if (kind === "payment" && session.kind === "tenant") return;
  if (session.kind === "staff" && session.role && can(session.role, kind === "expense" ? "exp.add" : "pay.record")) return;
  throw new FlowError("errors.forbidden");
}

export async function prepareReceiptUpload(
  session: Session,
  input: { kind: ReceiptKind; fileName: string; mime: string; size: number },
) {
  assertCanUpload(session, input.kind);
  const meta = assertReceiptMeta(input);
  const path = receiptPath(session.orgId, randomUUID(), meta.mime);
  const encoded = path.split("/").map((part) => encodeURIComponent(part)).join("/");
  const response = await storageRequest("POST", `/object/upload/sign/${RECEIPT_BUCKET}/${encoded}`);
  if (!response.ok) throw new FlowError("errors.receiptStorage");
  const payload = (await response.json()) as { url?: string; token?: string };
  if (!payload.url) throw new FlowError("errors.receiptStorage");
  return {
    path,
    token: payload.token ?? "",
    uploadUrl: absoluteStorageUrl(storageConfig()?.url ?? "", payload.url),
    mime: meta.mime,
    uploadToken: issueReceiptGrant(session.userId, path),
  };
}

function grantKey() {
  return process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.RECEIPT_GRANT_KEY || "";
}

/** Proves this user was given an upload URL for this path. */
export function issueReceiptGrant(userId: string, path: string) {
  const key = grantKey();
  if (!key) return "";
  return createHmac("sha256", key).update(`${userId}\n${path}`).digest("base64url");
}

export function receiptGrantMatches(userId: string, path: string, token: string) {
  const expected = issueReceiptGrant(userId, path);
  if (!expected || !token || expected.length !== token.length) return false;
  return timingSafeEqual(Buffer.from(expected), Buffer.from(token));
}

async function deleteObject(path: string) {
  const encoded = path.split("/").map((part) => encodeURIComponent(part)).join("/");
  await storageRequest("DELETE", `/object/${RECEIPT_BUCKET}/${encoded}`).catch(() => undefined);
}

async function readObjectHeader(path: string) {
  const cfg = storageConfig();
  if (!cfg) throw new FlowError("errors.receiptStorage");
  const encoded = path.split("/").map((part) => encodeURIComponent(part)).join("/");
  let response: Response;
  try {
    response = await fetch(`${cfg.url}/storage/v1/object/${RECEIPT_BUCKET}/${encoded}`, {
      method: "GET",
      cache: "no-store",
      signal: AbortSignal.timeout(8000),
      headers: {
        authorization: `Bearer ${cfg.key}`,
        apikey: cfg.key,
        range: `bytes=0-${RECEIPT_HEADER_BYTES - 1}`,
      },
    });
  } catch {
    throw new FlowError("errors.receiptStorage");
  }
  if (response.status !== 200 && response.status !== 206) {
    await response.body?.cancel().catch(() => undefined);
    throw new FlowError("errors.receiptStorage");
  }
  const reader = response.body?.getReader();
  if (!reader) throw new FlowError("errors.receiptStorage");
  const header = new Uint8Array(RECEIPT_HEADER_BYTES);
  let offset = 0;
  try {
    while (offset < RECEIPT_HEADER_BYTES) {
      const { done, value } = await reader.read();
      if (done || !value) break;
      const take = Math.min(value.length, RECEIPT_HEADER_BYTES - offset);
      header.set(value.subarray(0, take), offset);
      offset += take;
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  return header.subarray(0, offset);
}

async function objectInfo(path: string) {
  const encoded = path.split("/").map((part) => encodeURIComponent(part)).join("/");
  const infoResponse = await storageRequest("GET", `/object/info/${RECEIPT_BUCKET}/${encoded}`);
  if (!infoResponse.ok) return { ok: false as const };
  const info = (await infoResponse.json()) as { size?: number; contentType?: string; metadata?: { mimetype?: string } };
  return { ok: true as const, size: Number(info.size), mime: info.contentType || info.metadata?.mimetype || "" };
}

type ConfirmDeps = {
  info?: (path: string) => Promise<{ ok: boolean; size?: number; mime?: string }>;
  header?: (path: string) => Promise<Uint8Array>;
  remove?: (path: string) => Promise<void>;
  attach?: typeof attachReceiptFile;
};

const DISCARD_KEYS = new Set(["errors.receiptType", "errors.receiptSize", "errors.receiptStorage"]);

/** Inserts the files row for an object that already passed the signature check. */
export async function attachReceiptFile(
  session: Session,
  input: { path: string; fileName: string; mime: ReceiptMime; size: number },
  client?: Client,
) {
  const fileId = receiptFileId(input.path);
  if (!fileId || !isReceiptPath(input.path, session.orgId)) throw new FlowError("errors.forbidden");
  const meta = assertReceiptMeta(input);
  const write = async (db: Client) => {
    const existing = await db.query<{ id: string }>(
      `SELECT id::text FROM files WHERE org_id = $1 AND storage_bucket = $2 AND storage_path = $3`,
      [session.orgId, RECEIPT_BUCKET, input.path],
    );
    if (existing.rows[0]) return existing.rows[0].id;
    const inserted = await one<{ id: string }>(
      db,
      `INSERT INTO files (id, org_id, storage_bucket, storage_path, file_name, mime_type, size_bytes, uploaded_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
       RETURNING id::text`,
      [fileId, session.orgId, RECEIPT_BUCKET, input.path, meta.fileName, meta.mime, meta.size, session.userId],
    );
    return inserted.id;
  };
  if (client) return write(client);
  return tx(session.userId, write, { orgId: session.orgId, environment: session.environment });
}

export async function confirmReceipt(session: Session, input: ReceiptClaim, deps?: ConfirmDeps) {
  if (!isReceiptPath(input.path, session.orgId)) throw new FlowError("errors.forbidden");
  if (!receiptGrantMatches(session.userId, input.path, input.token)) throw new FlowError("errors.forbidden");
  const remove = deps?.remove ?? deleteObject;
  try {
    const meta = assertReceiptMeta(input);
    const info = await (deps?.info ?? objectInfo)(input.path);
    if (!info.ok) throw new FlowError("errors.receiptStorage");
    const header = await (deps?.header ?? readObjectHeader)(input.path);
    const accepted = acceptReceiptObject({ size: info.size ?? 0, mime: info.mime ?? "", header }, meta.mime);
    return await (deps?.attach ?? attachReceiptFile)(session, {
      path: input.path,
      fileName: meta.fileName,
      mime: accepted.mime,
      size: accepted.size,
    });
  } catch (error) {
    if (error instanceof FlowError && DISCARD_KEYS.has(error.key)) await remove(input.path);
    throw error;
  }
}

export function claimFromForm(formData: FormData): ReceiptClaim | null {
  const path = String(formData.get("receiptPath") ?? "").trim();
  if (!path) return null;
  const size = Number(formData.get("receiptSize"));
  return {
    path,
    token: String(formData.get("receiptToken") ?? ""),
    fileName: String(formData.get("receiptName") ?? ""),
    mime: String(formData.get("receiptMime") ?? ""),
    size,
  };
}

/** Short-lived read URL after the org path check. RLS already hid other firms. */
export async function openReceipt(session: Session, fileId: string) {
  if (!/^[0-9a-f-]{36}$/i.test(fileId)) return null;
  const row = await tx(
    session.userId,
    async (client) => {
      const found = await client.query<{ name: string; mime: string | null; path: string; org_id: string }>(
        `SELECT file_name AS name, mime_type AS mime, storage_path AS path, org_id::text
           FROM files
          WHERE id = $1 AND storage_bucket = $2`,
        [fileId, RECEIPT_BUCKET],
      );
      return found.rows[0] ?? null;
    },
    { orgId: session.orgId, environment: session.environment },
  );
  const cfg = storageConfig();
  if (!row || !cfg || !isReceiptPath(row.path, row.org_id)) return null;
  const signed = await signReceiptUrls(row.org_id, [row.path]);
  const url = signed[row.path];
  if (!url || !url.startsWith(`${cfg.url}/`)) return null;
  return { url, name: row.name, mime: row.mime || "application/octet-stream" };
}

export async function signReceiptUrls(orgId: string, paths: string[]) {
  const unique = receiptPaths(orgId, paths);
  if (!unique.length || !storageConfig()) return {} as Record<string, string>;
  try {
    const response = await storageRequest("POST", `/object/sign/${RECEIPT_BUCKET}`, { expiresIn: 600, paths: unique });
    if (!response.ok) return {};
    const rows = (await response.json()) as { path?: string; signedURL?: string; signedUrl?: string }[];
    const base = storageConfig()?.url ?? "";
    const signed: Record<string, string> = {};
    if (!Array.isArray(rows)) return signed;
    for (const row of rows) {
      const url = row.signedURL || row.signedUrl;
      if (row.path && url && isReceiptPath(row.path, orgId)) signed[row.path] = absoluteStorageUrl(base, url);
    }
    return signed;
  } catch {
    return {};
  }
}
