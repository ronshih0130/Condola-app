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
 * Only verified uploads hold a photo slot. The owner can remove one file or
 * discard the whole draft; closing a draft deletes its unattached rows and the
 * server removes their reserved objects.
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

function dbCode(error: unknown) {
  const cause = error instanceof FlowError ? (error.cause as { code?: unknown } | undefined) : undefined;
  return typeof cause?.code === "string" ? cause.code : "";
}

/** The draft was closed (submitted or discarded) — the client starts a new draft. */
const isClosed = (error: unknown) => dbCode(error) === "P0B33";

/**
 * One bounded transaction as the caller (RLS). Lock waits 3 s, statements 8 s, like
 * slice 1; a lock or statement timeout becomes the existing errors.busy result.
 */
async function batchTx<T>(session: Session, fn: (client: Client) => Promise<T>): Promise<T> {
  try {
    return await tx(session.userId, async (client) => {
      await client.query("SET LOCAL lock_timeout = '3s'");
      await client.query("SET LOCAL statement_timeout = '8s'");
      return fn(client);
    }, requireOrgScope(session));
  } catch (error) {
    const code = dbCode(error);
    if (code === "55P03" || code === "57014") throw new FlowError("errors.busy");
    throw error;
  }
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

/** Best effort, after commit: only reserved, unattached paths of the caller on this ticket. */
async function removeObjects(session: Session, ticketId: string, paths: string[], deps: UploadStorageDeps) {
  for (const path of paths) {
    if (!isTicketPhotoPath(path, session.orgId, ticketId)) continue;
    await (deps.remove ?? removeRepairObject)(path).catch(() => undefined);
  }
}

const DISCARD_KEYS = new Set(["errors.photoType", "errors.photoSize", "errors.photoHeic"]);

/** Verify the stored object for a `signed` item and mark it uploaded. */
async function adoptStored(session: Session, ticketId: string, batchKey: string, item: ItemRow, deps: UploadStorageDeps) {
  if (!isTicketPhotoPath(item.storage_path, session.orgId, ticketId)) throw new FlowError("errors.forbidden");
  const info = await (deps.info ?? repairObjectInfo)(item.storage_path);
  if (!info.ok) return "missing" as const;
  let accepted: { size: number; mime: string };
  try {
    const header = await (deps.header ?? repairObjectHeader)(item.storage_path);
    accepted = acceptPhotoObject({ size: info.size ?? 0, mime: info.mime ?? "", header }, item.mime_type);
  } catch (error) {
    // Reserved, unattached path of this caller only: the rejected object is removed.
    if (error instanceof FlowError && DISCARD_KEYS.has(error.key)) await (deps.remove ?? removeRepairObject)(item.storage_path);
    throw error;
  }
  return batchTx(session, async (client) => {
    await visibleTicket(client, session, ticketId);
    const marked = await one<{ state: UploadItemState }>(
      client,
      `SELECT app.b031_upload_mark_uploaded($1::uuid, $2::uuid, $3::uuid, $4, $5::bigint) AS state`,
      [session.orgId, batchKey, item.client_key, accepted.mime, accepted.size],
    );
    return marked.state;
  });
}

/**
 * Draft restore for the ticket page. One flag read when OFF. A restored `signed`
 * file whose object did reach storage (lost response, then reload) is verified and
 * adopted here, so re-choosing it is unnecessary and no second object is stored.
 */
export async function ticketPhotoRecovery(session: Session, ticketId: string, deps: UploadStorageDeps = {}): Promise<UploadRecoveryView> {
  if (!(await uploadRecoveryEnabled(session.orgId))) return null;
  try {
    assertActor(session, false);
    if (!isUuid(ticketId)) return { draft: null };
    const read = () => batchTx(session, async (client) => {
      await visibleTicket(client, session, ticketId);
      const open = await maybe<{ client_batch_key: string; internal: boolean }>(
        client,
        `SELECT client_batch_key::text, internal FROM app.b031_upload_open_draft($1::uuid, $2::uuid)`,
        [session.orgId, ticketId],
      );
      return open ? { open, rows: await batchItems(client, session, open.client_batch_key) } : null;
    });
    let found = await read();
    if (!found) return { draft: null };
    let adopted = false;
    for (const row of found.rows.filter((r) => r.state === "signed")) {
      try {
        if ((await adoptStored(session, ticketId, found.open.client_batch_key, row, deps)) === "uploaded") adopted = true;
      } catch {
        // Storage unavailable, limit reached or a rejected object: stays `signed` (choose again or remove).
      }
    }
    if (adopted) found = await read();
    if (!found) return { draft: null };
    return {
      draft: {
        batchKey: found.open.client_batch_key,
        internal: session.kind === "staff" && found.open.internal,
        items: found.rows.map((row) => ({ clientKey: row.client_key, name: row.file_name, state: row.state })),
      },
    };
  } catch (error) {
    if (error instanceof FlowError && (error.key === "errors.forbidden" || error.key === "errors.notFound")) return { draft: null };
    throw error;
  }
}

export type PrepareResult =
  | { state: "uploaded" | "attached" | "stored" | "closed" }
  | { state: "signed"; uploadUrl: string; token: string };

/**
 * Reserve (or replay) one file of a batch. "stored" means the object is already
 * in storage for this key (a lost response after the PUT): confirm, do not PUT.
 * "closed" means the draft was already submitted or discarded (e.g. a lost submit
 * response): the client starts a new draft key and sends the file again.
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
  let reserved: { storage_path: string; state: UploadItemState };
  try {
    reserved = await batchTx(session, async (client) => {
      await visibleTicket(client, session, input.ticketId);
      await client.query(`SELECT app.b031_upload_open_batch($1::uuid, $2::uuid, $3::uuid, $4::boolean)`,
        [session.orgId, input.ticketId, input.batchKey, input.internal]);
      return one<{ storage_path: string; state: UploadItemState }>(
        client,
        `SELECT storage_path, state FROM app.b031_upload_reserve($1::uuid, $2::uuid, $3::uuid, $4, $5, $6, $7::bigint)`,
        [session.orgId, input.batchKey, input.clientKey, proposed, meta.fileName, meta.mime, meta.size],
      );
    });
  } catch (error) {
    if (isClosed(error)) return { state: "closed" };
    throw error;
  }
  if (!isTicketPhotoPath(reserved.storage_path, session.orgId, input.ticketId)) throw new FlowError("errors.forbidden");
  if (reserved.state !== "signed") return { state: reserved.state };
  const info = await (deps.info ?? repairObjectInfo)(reserved.storage_path);
  if (info.ok) return { state: "stored" };
  const signed = await (deps.sign ?? signRepairUpload)(reserved.storage_path);
  return { state: "signed", uploadUrl: signed.uploadUrl, token: signed.token };
}

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
  const item = await batchTx(session, async (client) => {
    await visibleTicket(client, session, input.ticketId);
    return (await batchItems(client, session, input.batchKey)).find((row) => row.client_key === input.clientKey) ?? null;
  });
  if (!item || item.ticket_id !== input.ticketId) throw new FlowError("errors.forbidden");
  if (item.state !== "signed") return { state: item.state };
  return { state: await adoptStored(session, input.ticketId, input.batchKey, item, deps) };
}

/**
 * Final submit. Attaches every uploaded file of the batch exactly once, in one
 * transaction holding the batch lock, then closes the draft (unattached rows are
 * deleted and their reserved objects removed after commit). A replay of a closed
 * batch returns the same attachment ids and writes nothing.
 */
export async function submitBatchPhotos(
  session: Session,
  input: { ticketId: string; batchKey: string; internal: boolean },
  deps: UploadStorageDeps = {},
): Promise<{ attached: string[]; skipped: number }> {
  await requireEnabled(session);
  assertActor(session, input.internal);
  requireKeys(input.ticketId, input.batchKey);
  const outcome = await batchTx(session, async (client) => {
    const ticket = await visibleTicket(client, session, input.ticketId);
    const locked = await one<{ submitted: boolean }>(
      client,
      `SELECT app.b031_upload_lock_batch($1::uuid, $2::uuid, $3::boolean) AS submitted`,
      [session.orgId, input.batchKey, input.internal],
    );
    const rows = await batchItems(client, session, input.batchKey);
    if (rows.some((row) => row.ticket_id !== ticket.id)) throw new FlowError("errors.forbidden");
    const attachedBefore = rows.filter((row) => row.state === "attached").map((row) => row.attachment_id!);
    if (locked.submitted) return { attached: attachedBefore, skipped: 0, removed: [] as string[] };
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
    const removed = (await client.query<{ path: string }>(
      `SELECT app.b031_upload_close_batch($1::uuid, $2::uuid, false) AS path`, [session.orgId, input.batchKey])).rows.map((r) => r.path);
    return { attached, skipped: rows.length - attached.length, removed };
  });
  await removeObjects(session, input.ticketId, outcome.removed, deps);
  return { attached: outcome.attached, skipped: outcome.skipped };
}

/**
 * The owner removes one unattached file (clientKey) or discards the whole open draft
 * without attaching anything. Reserved objects are removed after commit.
 */
export async function discardBatchPhotos(
  session: Session,
  input: { ticketId: string; batchKey: string; clientKey?: string },
  deps: UploadStorageDeps = {},
): Promise<{ removed: number; state: "open" | "closed" }> {
  await requireEnabled(session);
  assertActor(session, false);
  requireKeys(input.ticketId, input.batchKey, ...(input.clientKey === undefined ? [] : [input.clientKey]));
  let paths: string[];
  try {
    paths = await batchTx(session, async (client) => {
      await visibleTicket(client, session, input.ticketId);
      const own = await batchItems(client, session, input.batchKey);
      if (own.some((row) => row.ticket_id !== input.ticketId)) throw new FlowError("errors.forbidden");
      if (input.clientKey !== undefined) {
        const item = await client.query<{ path: string | null }>(
          `SELECT app.b031_upload_discard_item($1::uuid, $2::uuid, $3::uuid) AS path`, [session.orgId, input.batchKey, input.clientKey]);
        return item.rows.flatMap((r) => (r.path ? [r.path] : []));
      }
      return (await client.query<{ path: string }>(
        `SELECT app.b031_upload_close_batch($1::uuid, $2::uuid, true) AS path`, [session.orgId, input.batchKey])).rows.map((r) => r.path);
    });
  } catch (error) {
    if (isClosed(error)) return { removed: 0, state: "closed" };
    throw error;
  }
  await removeObjects(session, input.ticketId, paths, deps);
  return { removed: paths.length, state: input.clientKey === undefined ? "closed" : "open" };
}
