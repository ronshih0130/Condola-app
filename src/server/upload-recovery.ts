import type { Client } from "pg";
import { maybe, one, query, tx } from "./db";
import { FlowError } from "./errors";
import { requireOrgScope } from "./org-guard";
import { assertPerm } from "./perms";
import {
  PHOTO_BUCKET,
  acceptPhotoObject,
  assertPhotoMeta,
  isTicketPhotoPath,
  isUuid,
  normalizePhotoMime,
  photoFileId,
  ticketPhotoPath,
} from "./repair-rules";
import { newPhotoFileId } from "./repairs";
import { removeRepairObject, repairObjectHeader, repairObjectInfo, signRepairUpload } from "./ticket-photos";
import type { Session } from "./types";
import type { UploadItemState, UploadRecoveryDraft, UploadRecoveryView } from "@/lib/upload-recovery-types";

/**
 * B-031 slice 3 UPLOAD_RECOVERY (flag `upload_recovery`, default OFF).
 *
 * Retry-safe multi-photo uploads for repair tickets. The browser gives every
 * selected file a random client key and every selection a random batch key.
 * The server keeps a private draft (app.b031_upload_batches) and one row per
 * (org, batch, client key) (app.b031_upload_items). A replayed key returns the
 * same storage path and state, so a file that already succeeded is not stored
 * or attached twice, and a failed file can be retried alone. Final submit
 * inserts files + ticket_attachments once, through the caller's existing RLS.
 *
 * Flag OFF: every entry point issues only the flag read and writes nothing.
 */

export type { UploadItemState, UploadRecoveryDraft, UploadRecoveryView };

export type UploadStorageDeps = {
  info?: (path: string) => Promise<{ ok: boolean; size?: number; mime?: string }>;
  header?: (path: string) => Promise<Uint8Array>;
  sign?: (path: string) => Promise<{ token: string; uploadUrl: string }>;
  remove?: (path: string) => Promise<void>;
};

type ItemRow = {
  ticket_id: string;
  internal: boolean;
  submitted: boolean;
  client_key: string;
  storage_path: string;
  file_name: string;
  mime_type: string;
  size_bytes: string;
  state: UploadItemState;
  attachment_id: string | null;
};

export async function uploadRecoveryEnabled(orgId: string) {
  if (!isUuid(orgId)) return false;
  const result = await query<{ enabled: boolean }>(`SELECT app.b031_upload_recovery_on($1::uuid) AS enabled`, [orgId]);
  return result.rows[0]?.enabled === true;
}

function assertActor(session: Session, internal: boolean) {
  if (session.kind === "staff") assertPerm(session, "tickets.update");
  else if (session.kind !== "tenant" || internal) throw new FlowError("errors.forbidden");
}

async function requireEnabled(session: Session) {
  if (!(await uploadRecoveryEnabled(session.orgId))) throw new FlowError("errors.notFound");
}

function requireKeys(...keys: string[]) {
  if (!keys.every((key) => isUuid(key))) throw new FlowError("errors.notFound");
}

/** The ticket must be visible to the caller under the existing ticket RLS. */
async function visibleTicket(client: Client, session: Session, ticketId: string) {
  const ticket = await maybe<{ id: string; org_id: string }>(
    client,
    `SELECT id::text, org_id::text FROM maintenance_tickets WHERE id = $1 AND org_id = $2`,
    [ticketId, session.orgId],
  );
  if (!ticket) throw new FlowError("errors.notFound");
  return ticket;
}

async function batchItems(client: Client, session: Session, batchKey: string) {
  const result = await client.query<ItemRow>(
    `SELECT ticket_id::text, internal, submitted, client_key::text, storage_path, file_name, mime_type,
            size_bytes::text, state, attachment_id::text
       FROM app.b031_upload_items_for($1::uuid, $2::uuid)`,
    [session.orgId, batchKey],
  );
  return result.rows;
}

/** Draft restore for the ticket page. One flag read when OFF. */
export async function ticketPhotoRecovery(session: Session, ticketId: string): Promise<UploadRecoveryView> {
  if (!(await uploadRecoveryEnabled(session.orgId))) return null;
  try {
    assertActor(session, false);
    if (!isUuid(ticketId)) return { draft: null };
    const draft = await tx(session.userId, async (client) => {
      await visibleTicket(client, session, ticketId);
      const open = await maybe<{ client_batch_key: string; internal: boolean }>(
        client,
        `SELECT client_batch_key::text, internal FROM app.b031_upload_open_draft($1::uuid, $2::uuid)`,
        [session.orgId, ticketId],
      );
      if (!open) return null;
      const rows = await batchItems(client, session, open.client_batch_key);
      return {
        batchKey: open.client_batch_key,
        internal: session.kind === "staff" && open.internal,
        items: rows.map((row) => ({ clientKey: row.client_key, name: row.file_name, state: row.state })),
      };
    }, requireOrgScope(session));
    return { draft };
  } catch (error) {
    if (error instanceof FlowError && (error.key === "errors.forbidden" || error.key === "errors.notFound")) return { draft: null };
    throw error;
  }
}

export type PrepareResult =
  | { state: "uploaded" | "attached" | "stored" }
  | { state: "signed"; uploadUrl: string; token: string };

/**
 * Reserve (or replay) one file of a batch. "stored" means the object is already
 * in storage for this key (a lost response after the PUT): confirm, do not PUT.
 */
export async function prepareBatchPhoto(
  session: Session,
  input: { ticketId: string; batchKey: string; clientKey: string; fileName: string; mime: string; size: number; internal: boolean },
  deps: UploadStorageDeps = {},
): Promise<PrepareResult> {
  await requireEnabled(session);
  assertActor(session, input.internal);
  requireKeys(input.ticketId, input.batchKey, input.clientKey);
  const meta = assertPhotoMeta(input);
  const proposed = ticketPhotoPath(session.orgId, input.ticketId, newPhotoFileId(), meta.mime);
  const reserved = await tx(session.userId, async (client) => {
    await visibleTicket(client, session, input.ticketId);
    await client.query(`SELECT app.b031_upload_open_batch($1::uuid, $2::uuid, $3::uuid, $4::boolean)`,
      [session.orgId, input.ticketId, input.batchKey, input.internal]);
    return one<{ storage_path: string; state: UploadItemState }>(
      client,
      `SELECT storage_path, state FROM app.b031_upload_reserve($1::uuid, $2::uuid, $3::uuid, $4, $5, $6, $7::bigint)`,
      [session.orgId, input.batchKey, input.clientKey, proposed, meta.fileName, meta.mime, meta.size],
    );
  }, requireOrgScope(session));
  if (!isTicketPhotoPath(reserved.storage_path, session.orgId, input.ticketId)) throw new FlowError("errors.forbidden");
  if (reserved.state !== "signed") return { state: reserved.state };
  const info = await (deps.info ?? repairObjectInfo)(reserved.storage_path);
  if (info.ok) return { state: "stored" };
  const signed = await (deps.sign ?? signRepairUpload)(reserved.storage_path);
  return { state: "signed", uploadUrl: signed.uploadUrl, token: signed.token };
}

const DISCARD_KEYS = new Set(["errors.photoType", "errors.photoSize", "errors.photoHeic"]);

/**
 * Verify the stored object for this key and mark it uploaded (not attached).
 * "missing" means no object yet: the client retries prepare + PUT for the same key.
 */
export async function confirmBatchPhoto(
  session: Session,
  input: { ticketId: string; batchKey: string; clientKey: string },
  deps: UploadStorageDeps = {},
): Promise<{ state: UploadItemState | "missing" }> {
  await requireEnabled(session);
  assertActor(session, false);
  requireKeys(input.ticketId, input.batchKey, input.clientKey);
  const item = await tx(session.userId, async (client) => {
    await visibleTicket(client, session, input.ticketId);
    return (await batchItems(client, session, input.batchKey)).find((row) => row.client_key === input.clientKey) ?? null;
  }, requireOrgScope(session));
  if (!item || item.ticket_id !== input.ticketId) throw new FlowError("errors.forbidden");
  if (item.state !== "signed") return { state: item.state };
  if (!isTicketPhotoPath(item.storage_path, session.orgId, input.ticketId)) throw new FlowError("errors.forbidden");
  const info = await (deps.info ?? repairObjectInfo)(item.storage_path);
  if (!info.ok) return { state: "missing" };
  let accepted: { size: number; mime: string };
  try {
    const header = await (deps.header ?? repairObjectHeader)(item.storage_path);
    accepted = acceptPhotoObject({ size: info.size ?? 0, mime: info.mime ?? "", header }, item.mime_type);
  } catch (error) {
    // Reserved, unattached path of this caller only: the rejected object is removed.
    if (error instanceof FlowError && DISCARD_KEYS.has(error.key)) await (deps.remove ?? removeRepairObject)(item.storage_path);
    throw error;
  }
  const state = await tx(session.userId, async (client) => {
    await visibleTicket(client, session, input.ticketId);
    const marked = await one<{ state: UploadItemState }>(
      client,
      `SELECT app.b031_upload_mark_uploaded($1::uuid, $2::uuid, $3::uuid, $4, $5::bigint) AS state`,
      [session.orgId, input.batchKey, input.clientKey, accepted.mime, accepted.size],
    );
    return marked.state;
  }, requireOrgScope(session));
  return { state };
}

/**
 * Final submit. Attaches every uploaded file of the batch exactly once, in one
 * transaction holding the batch lock, then closes the draft. A replay of a
 * submitted batch returns the same attachment ids and writes nothing.
 */
export async function submitBatchPhotos(
  session: Session,
  input: { ticketId: string; batchKey: string; internal: boolean },
): Promise<{ attached: string[]; skipped: number }> {
  await requireEnabled(session);
  assertActor(session, input.internal);
  requireKeys(input.ticketId, input.batchKey);
  return tx(session.userId, async (client) => {
    const ticket = await visibleTicket(client, session, input.ticketId);
    const locked = await one<{ submitted: boolean }>(
      client,
      `SELECT app.b031_upload_lock_batch($1::uuid, $2::uuid, $3::boolean) AS submitted`,
      [session.orgId, input.batchKey, input.internal],
    );
    const rows = await batchItems(client, session, input.batchKey);
    if (rows.some((row) => row.ticket_id !== ticket.id)) throw new FlowError("errors.forbidden");
    const attachedBefore = rows.filter((row) => row.state === "attached").map((row) => row.attachment_id!);
    if (locked.submitted) return { attached: attachedBefore, skipped: rows.length - attachedBefore.length };
    const uploaded = rows.filter((row) => row.state === "uploaded");
    if (!uploaded.length) throw new FlowError("errors.required");
    const internal = session.kind === "staff" && (rows[0]?.internal ?? false);
    const attached = [...attachedBefore];
    for (const row of uploaded) {
      const fileId = photoFileId(row.storage_path);
      const mime = normalizePhotoMime(row.mime_type);
      if (!fileId || !mime || !isTicketPhotoPath(row.storage_path, ticket.org_id, ticket.id)) throw new FlowError("errors.forbidden");
      await client.query(
        `INSERT INTO files (id, org_id, storage_bucket, storage_path, file_name, mime_type, size_bytes, uploaded_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [fileId, ticket.org_id, PHOTO_BUCKET, row.storage_path, row.file_name, mime, Number(row.size_bytes), session.userId],
      );
      const attachment = await one<{ id: string }>(
        client,
        `INSERT INTO ticket_attachments (org_id, ticket_id, file_id, is_internal)
         VALUES ($1,$2,$3,$4) RETURNING id::text`,
        [ticket.org_id, ticket.id, fileId, internal],
      );
      await client.query(`SELECT app.b031_upload_mark_attached($1::uuid, $2::uuid, $3::uuid, $4::uuid)`,
        [session.orgId, input.batchKey, row.client_key, attachment.id]);
      attached.push(attachment.id);
    }
    await client.query(`SELECT app.b031_upload_close_batch($1::uuid, $2::uuid)`, [session.orgId, input.batchKey]);
    return { attached, skipped: rows.length - attached.length };
  }, requireOrgScope(session));
}
