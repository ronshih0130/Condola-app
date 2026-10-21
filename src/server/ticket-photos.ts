import { FlowError } from "./errors";
import { attachRepairPhoto, newPhotoFileId, repairPhotoTarget } from "./repairs";
import {
  PHOTO_BUCKET,
  PHOTO_LIMIT,
  acceptPhotoObject,
  assertPhotoMeta,
  isTicketPhotoPath,
  ticketPhotoPath,
  type PhotoMime,
} from "./repair-rules";
import type { Session } from "./types";

/**
 * Ticket photos are stored in a private Supabase bucket and transferred with
 * signed URLs. The Worker never reads the image body and never re-encodes it.
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
  };
}

async function deleteObject(path: string) {
  const encoded = path.split("/").map((part) => encodeURIComponent(part)).join("/");
  await storageRequest("DELETE", `/object/${PHOTO_BUCKET}/${encoded}`).catch(() => undefined);
}

export async function confirmTicketPhoto(
  session: Session,
  input: { ticketId: string; path: string; fileName: string; mime: string; size: number; internal: boolean },
) {
  const meta = assertPhotoMeta({ fileName: input.fileName, mime: input.mime, size: input.size });
  const ticket = await repairPhotoTarget(session, input.ticketId);
  if (!ticket) throw new FlowError("errors.notFound");
  if (!isTicketPhotoPath(input.path, ticket.org_id, input.ticketId)) throw new FlowError("errors.forbidden");

  const encoded = input.path.split("/").map((part) => encodeURIComponent(part)).join("/");
  const infoResponse = await storageRequest("GET", `/object/info/${PHOTO_BUCKET}/${encoded}`);
  if (!infoResponse.ok) throw new FlowError("errors.photoStorage");
  const info = (await infoResponse.json()) as { size?: number; contentType?: string; metadata?: { mimetype?: string } };
  const mime = info.contentType || info.metadata?.mimetype || "";
  let accepted: { size: number; mime: PhotoMime };
  try {
    accepted = acceptPhotoObject({ size: Number(info.size), mime }, meta.mime);
  } catch (error) {
    await deleteObject(input.path);
    throw error;
  }
  try {
    return await attachRepairPhoto(session, {
      ticketId: input.ticketId,
      path: input.path,
      fileName: meta.fileName,
      mime: accepted.mime,
      size: accepted.size,
      internal: input.internal,
    });
  } catch (error) {
    if (error instanceof FlowError && error.key === "errors.photoLimit") await deleteObject(input.path);
    throw error;
  }
}

/** One batch of short-lived read URLs. Missing storage leaves photos unnamed. */
export async function signTicketPhotoUrls(paths: string[]) {
  const unique = [...new Set(paths.filter(Boolean))];
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
      if (row.path && url) signed[row.path] = absoluteStorageUrl(base, url);
    }
    return signed;
  } catch {
    return {};
  }
}
