import { createHmac, timingSafeEqual } from "node:crypto";
import { FlowError } from "./errors";
import { attachRepairPhoto, findRepairPhoto, newPhotoFileId, readRepairPhoto, repairPhotoTarget } from "./repairs";
import {
  PHOTO_BUCKET,
  PHOTO_HEADER_BYTES,
  PHOTO_LIMIT,
  acceptPhotoObject,
  assertPhotoMeta,
  isTicketPhotoPath,
  ticketPhotoPath,
  ticketPhotoPaths,
} from "./repair-rules";
import type { Session } from "./types";

/**
 * Ticket photos are stored in a private Supabase bucket and transferred with
 * signed URLs. JPEG, PNG, and WEBP are checked from the first 16 bytes and
 * are not re-encoded. HEIC and unknown signatures are rejected at confirm.
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
  if (!cfg) throw new FlowError("errors.photoStorage");
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

/** Service-authenticated download; callers must authorize the ticket and object path. */
export async function downloadRepairObject(path: string): Promise<Uint8Array> {
  const encoded = path.split("/").map((part) => encodeURIComponent(part)).join("/");
  const response = await storageRequest("GET", `/object/${PHOTO_BUCKET}/${encoded}`);
  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined);
    throw new FlowError("errors.photoStorage");
  }
  return new Uint8Array(await response.arrayBuffer());
}

export async function signRepairUpload(path: string) {
  const encoded = path.split("/").map((part) => encodeURIComponent(part)).join("/");
  const response = await storageRequest("POST", `/object/upload/sign/${PHOTO_BUCKET}/${encoded}`);
  if (!response.ok) throw new FlowError("errors.photoStorage");
  const payload = (await response.json()) as { url?: string; token?: string };
  if (!payload.url) throw new FlowError("errors.photoStorage");
  return {
    token: payload.token ?? "",
    uploadUrl: absoluteStorageUrl(storageConfig()?.url ?? "", payload.url),
  };
}

export async function prepareTicketPhotoUpload(
  session: Session,
  input: { ticketId: string; fileName: string; mime: string; size: number },
) {
  const meta = assertPhotoMeta(input);
  const ticket = await repairPhotoTarget(session, input.ticketId);
  if (!ticket) throw new FlowError("errors.notFound");
  if (Number(ticket.count) >= PHOTO_LIMIT) throw new FlowError("errors.photoLimit");
  const path = ticketPhotoPath(ticket.org_id, input.ticketId, newPhotoFileId(), meta.mime);
  const signed = await signRepairUpload(path);
  return {
    path,
    token: signed.token,
    uploadUrl: signed.uploadUrl,
    mime: meta.mime,
    uploadToken: issueUploadGrant(session.userId, input.ticketId, path),
  };
}

function grantKey() {
  return process.env.SUPABASE_SERVICE_ROLE_KEY || "";
}

/** Proves this user was given an upload URL for this ticket path. */
export function issueUploadGrant(userId: string, ticketId: string, path: string) {
  const key = grantKey();
  if (!key) return "";
  return createHmac("sha256", key).update(`${userId}\n${ticketId}\n${path}`).digest("base64url");
}

export function uploadGrantMatches(userId: string, ticketId: string, path: string, token: string) {
  const expected = issueUploadGrant(userId, ticketId, path);
  if (!expected || !token || expected.length !== token.length) return false;
  return timingSafeEqual(Buffer.from(expected), Buffer.from(token));
}

/** Bound to the vendor link hash, not a user id. A staff grant cannot be reused here. */
export function issueVendorUploadGrant(tokenHash: string, ticketId: string, path: string) {
  const key = grantKey();
  if (!key) return "";
  return createHmac("sha256", key).update(`vendor\n${tokenHash}\n${ticketId}\n${path}`).digest("base64url");
}

export function vendorUploadGrantMatches(tokenHash: string, ticketId: string, path: string, token: string) {
  const expected = issueVendorUploadGrant(tokenHash, ticketId, path);
  if (!expected || !token || expected.length !== token.length) return false;
  return timingSafeEqual(Buffer.from(expected), Buffer.from(token));
}

/** An attached object is never removed. A storage delete needs a grant from sign. */
export function discardUploadAllowed(attachmentId: string | null, issued: boolean) {
  return attachmentId == null && issued;
}

async function deleteObject(path: string) {
  const encoded = path.split("/").map((part) => encodeURIComponent(part)).join("/");
  await storageRequest("DELETE", `/object/${PHOTO_BUCKET}/${encoded}`).catch(() => undefined);
}

export async function removeRepairObject(path: string) {
  await deleteObject(path);
}

export async function inspectRepairObject(path: string) {
  return ensureJpegObject(path);
}

/** B-031 upload recovery: stored-object probe and magic bytes, same requests as confirm. */
export async function repairObjectInfo(path: string) {
  return objectInfo(path);
}

export async function repairObjectHeader(path: string) {
  return readObjectHeader(path);
}

/** First bytes of the object. A range request plus cancel avoids reading the file. */
async function readObjectHeader(path: string) {
  const cfg = storageConfig();
  if (!cfg) throw new FlowError("errors.photoStorage");
  const encoded = path.split("/").map((part) => encodeURIComponent(part)).join("/");
  // A signal skips Next's fetch dedupe, which tees the body and stalls on a 206.
  let response: Response;
  try {
    response = await fetch(`${cfg.url}/storage/v1/object/${PHOTO_BUCKET}/${encoded}`, {
      method: "GET",
      cache: "no-store",
      signal: AbortSignal.timeout(8000),
      headers: {
        authorization: `Bearer ${cfg.key}`,
        apikey: cfg.key,
        range: `bytes=0-${PHOTO_HEADER_BYTES - 1}`,
      },
    });
  } catch {
    throw new FlowError("errors.photoStorage");
  }
  if (response.status !== 200 && response.status !== 206) {
    await response.body?.cancel().catch(() => undefined);
    throw new FlowError("errors.photoStorage");
  }
  const reader = response.body?.getReader();
  if (!reader) throw new FlowError("errors.photoStorage");
  const header = new Uint8Array(PHOTO_HEADER_BYTES);
  let offset = 0;
  try {
    while (offset < PHOTO_HEADER_BYTES) {
      const { done, value } = await reader.read();
      if (done || !value) break;
      const take = Math.min(value.length, PHOTO_HEADER_BYTES - offset);
      header.set(value.subarray(0, take), offset);
      offset += take;
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  return header.subarray(0, offset);
}

/** Read stored metadata and magic bytes without decoding or replacing the object. */
export async function ensureJpegObject(path: string) {
  const info = await objectInfo(path);
  if (!info.ok) throw new FlowError("errors.photoStorage");
  const header = await readObjectHeader(path);
  return { size: info.size ?? 0, mime: info.mime ?? "", header };
}

type ConfirmDeps = {
  target?: typeof repairPhotoTarget;
  existing?: typeof findRepairPhoto;
  info?: (path: string) => Promise<{ ok: boolean; size?: number; mime?: string }>;
  header?: (path: string) => Promise<Uint8Array>;
  remove?: (path: string) => Promise<void>;
  attach?: typeof attachRepairPhoto;
};

const DISCARD_KEYS = new Set(["errors.photoLimit", "errors.photoType", "errors.photoSize", "errors.photoStorage", "errors.photoHeic"]);

async function objectInfo(path: string) {
  const encoded = path.split("/").map((part) => encodeURIComponent(part)).join("/");
  const infoResponse = await storageRequest("GET", `/object/info/${PHOTO_BUCKET}/${encoded}`);
  if (!infoResponse.ok) return { ok: false as const };
  const info = (await infoResponse.json()) as { size?: number; contentType?: string; metadata?: { mimetype?: string } };
  return { ok: true as const, size: Number(info.size), mime: info.contentType || info.metadata?.mimetype || "" };
}

export async function confirmTicketPhoto(
  session: Session,
  input: {
    ticketId: string;
    path: string;
    fileName: string;
    mime: string;
    size: number;
    internal: boolean;
    uploadToken?: string;
  },
  deps?: ConfirmDeps,
) {
  const target = await (deps?.target ?? repairPhotoTarget)(session, input.ticketId);
  if (!target) throw new FlowError("errors.notFound");
  if (!isTicketPhotoPath(input.path, target.org_id, input.ticketId)) throw new FlowError("errors.forbidden");

  const lookup = deps?.existing ?? findRepairPhoto;
  const existing = await lookup(session, input.ticketId, input.path);
  if (existing) return existing;

  const issued = uploadGrantMatches(session.userId, input.ticketId, input.path, input.uploadToken ?? "");
  if (!issued) throw new FlowError("errors.forbidden");

  const remove = deps?.remove ?? deleteObject;
  const discard = async () => {
    const again = await lookup(session, input.ticketId, input.path);
    if (!discardUploadAllowed(again, uploadGrantMatches(session.userId, input.ticketId, input.path, input.uploadToken ?? ""))) return;
    await remove(input.path);
  };

  try {
    const meta = assertPhotoMeta({ fileName: input.fileName, mime: input.mime, size: input.size });
    const stored =
      deps?.info || deps?.header
        ? await (async () => {
            const info = await (deps?.info ?? objectInfo)(input.path);
            if (!info.ok) throw new FlowError("errors.photoStorage");
            const header = await (deps?.header ?? readObjectHeader)(input.path);
            return { size: info.size ?? 0, mime: info.mime ?? "", header };
          })()
        : await ensureJpegObject(input.path);
    const accepted = acceptPhotoObject({ size: stored.size, mime: stored.mime, header: stored.header }, meta.mime);
    return await (deps?.attach ?? attachRepairPhoto)(session, {
      ticketId: input.ticketId,
      path: input.path,
      fileName: meta.fileName,
      mime: meta.mime,
      storedMime: stored.mime,
      size: accepted.size,
      internal: input.internal,
      header: stored.header,
    });
  } catch (error) {
    if (error instanceof FlowError && DISCARD_KEYS.has(error.key)) await discard();
    throw error;
  }
}

/** Map expected photo access failures to the GET route's existing 404 response. */
export async function ticketPhotoResponse(open: () => Promise<{ url: string } | null>): Promise<Response> {
  try {
    const photo = await open();
    if (!photo) return new Response("Not found", { status: 404 });
    return Response.redirect(photo.url, 302);
  } catch (error) {
    if (error instanceof FlowError && (error.key === "errors.forbidden" || error.key === "errors.notFound")) {
      return new Response("Not found", { status: 404 });
    }
    throw error;
  }
}

/**
 * Short-lived read URL after the org and ticket path check.
 * The browser loads the object from the bucket. This does not read ticket_attachments.content.
 */
export async function openTicketPhoto(session: Session, attachmentId: string) {
  const row = await readRepairPhoto(session, attachmentId);
  const cfg = storageConfig();
  if (!row || !cfg || !isTicketPhotoPath(row.path, session.orgId, row.ticket_id)) return null;
  const signed = await signTicketPhotoUrls(session.orgId, row.ticket_id, [row.path]);
  const url = signed[row.path];
  if (!url || !url.startsWith(`${cfg.url}/`)) return null;
  return { url, name: row.name, mime: row.mime || "application/octet-stream" };
}

/** One batch of short-lived read URLs. The service key only signs this ticket's paths. */
export async function signTicketPhotoUrls(orgId: string, ticketId: string, paths: string[]) {
  const unique = ticketPhotoPaths(orgId, ticketId, paths);
  if (!unique.length || !storageConfig()) return {} as Record<string, string>;
  try {
    const response = await storageRequest("POST", `/object/sign/${PHOTO_BUCKET}`, { expiresIn: 600, paths: unique });
    if (!response.ok) return {};
    const rows = (await response.json()) as { path?: string; signedURL?: string; signedUrl?: string }[];
    const base = storageConfig()?.url ?? "";
    const signed: Record<string, string> = {};
    if (!Array.isArray(rows)) return signed;
    for (const row of rows) {
      const url = row.signedURL || row.signedUrl;
      if (row.path && url && isTicketPhotoPath(row.path, orgId, ticketId)) signed[row.path] = absoluteStorageUrl(base, url);
    }
    return signed;
  } catch {
    return {};
  }
}
