import { createHmac, timingSafeEqual } from "node:crypto";
import { FlowError } from "./errors";
import { attachRepairPhoto, findRepairPhoto, newPhotoFileId, repairPhotoTarget } from "./repairs";
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
 * signed URLs. Confirm reads the first 16 bytes to check the file signature,
 * then cancels the rest. The Worker does not decode or re-encode the image.
 * That keeps this off the Cloudflare Workers free-plan 10ms CPU budget.
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
    headers: {
      authorization: `Bearer ${cfg.key}`,
      apikey: cfg.key,
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return response;
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
  const encoded = path.split("/").map((part) => encodeURIComponent(part)).join("/");
  const response = await storageRequest("POST", `/object/upload/sign/${PHOTO_BUCKET}/${encoded}`);
  if (!response.ok) throw new FlowError("errors.photoStorage");
  const payload = (await response.json()) as { url?: string; token?: string };
  if (!payload.url) throw new FlowError("errors.photoStorage");
  return {
    path,
    token: payload.token ?? "",
    uploadUrl: absoluteStorageUrl(storageConfig()?.url ?? "", payload.url),
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

/** An attached object is never removed. A storage delete needs a grant from sign. */
export function discardUploadAllowed(attachmentId: string | null, issued: boolean) {
  return attachmentId == null && issued;
}

async function deleteObject(path: string) {
  const encoded = path.split("/").map((part) => encodeURIComponent(part)).join("/");
  await storageRequest("DELETE", `/object/${PHOTO_BUCKET}/${encoded}`).catch(() => undefined);
}

/** First bytes of the object. A range request plus cancel avoids reading the file. */
async function readObjectHeader(path: string) {
  const cfg = storageConfig();
  if (!cfg) throw new FlowError("errors.photoStorage");
  const encoded = path.split("/").map((part) => encodeURIComponent(part)).join("/");
  const response = await fetch(`${cfg.url}/storage/v1/object/${PHOTO_BUCKET}/${encoded}`, {
    method: "GET",
    headers: {
      authorization: `Bearer ${cfg.key}`,
      apikey: cfg.key,
      range: `bytes=0-${PHOTO_HEADER_BYTES - 1}`,
    },
  });
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

type ConfirmDeps = {
  target?: typeof repairPhotoTarget;
  existing?: typeof findRepairPhoto;
  info?: (path: string) => Promise<{ ok: boolean; size?: number; mime?: string }>;
  header?: (path: string) => Promise<Uint8Array>;
  remove?: (path: string) => Promise<void>;
  attach?: typeof attachRepairPhoto;
};

const DISCARD_KEYS = new Set(["errors.photoLimit", "errors.photoType", "errors.photoSize", "errors.photoStorage"]);

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
    const info = await (deps?.info ?? objectInfo)(input.path);
    if (!info.ok) throw new FlowError("errors.photoStorage");
    const header = await (deps?.header ?? readObjectHeader)(input.path);
    const accepted = acceptPhotoObject({ size: info.size ?? 0, mime: info.mime ?? "", header }, meta.mime);
    return await (deps?.attach ?? attachRepairPhoto)(session, {
      ticketId: input.ticketId,
      path: input.path,
      fileName: meta.fileName,
      mime: meta.mime,
      storedMime: info.mime ?? "",
      size: accepted.size,
      internal: input.internal,
      header,
    });
  } catch (error) {
    if (error instanceof FlowError && DISCARD_KEYS.has(error.key)) await discard();
    throw error;
  }
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
