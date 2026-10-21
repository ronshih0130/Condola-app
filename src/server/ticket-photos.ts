import { FlowError } from "./errors";
import { attachRepairPhoto, newPhotoFileId, repairPhotoTarget } from "./repairs";
import {
  PHOTO_BUCKET,
  PHOTO_HEADER_BYTES,
  PHOTO_LIMIT,
  assertPhotoMeta,
  isTicketPhotoPath,
  ticketPhotoPath,
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
  };
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
  let header: Uint8Array;
  try {
    header = await readObjectHeader(input.path);
  } catch (error) {
    await deleteObject(input.path);
    throw error;
  }
  try {
    return await attachRepairPhoto(session, {
      ticketId: input.ticketId,
      path: input.path,
      fileName: meta.fileName,
      mime: meta.mime,
      storedMime: mime,
      size: Number(info.size),
      internal: input.internal,
      header,
    });
  } catch (error) {
    if (
      error instanceof FlowError &&
      (error.key === "errors.photoLimit" || error.key === "errors.photoType" || error.key === "errors.photoSize")
    ) {
      await deleteObject(input.path);
    }
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
