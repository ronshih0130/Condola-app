import { randomUUID } from "node:crypto";
import type { Client } from "pg";
import { maybe, one, tx } from "./db";
import { FlowError } from "./errors";
import { taipeiToday } from "./money";
import { can, assertPerm } from "./perms";
import {
  PHOTO_BUCKET,
  PHOTO_LIMIT,
  acceptPhotoObject,
  assertCostBearer,
  assertPhotoMeta,
  assertTicketStatus,
  cleanVendorName,
  completionDate,
  datesInOrder,
  expenseLinkPlan,
  isTicketPhotoPath,
  isUuid,
  parseOptionalDate,
  parseOptionalMoney,
  photoFileId,
} from "./repair-rules";
import type { Session } from "./types";

export type RepairInput = {
  status: string;
  note: string;
  internal: boolean;
  vendorName: string;
  estimated: string;
  finalCost: string;
  costBearer: string;
  scheduledOn: string;
  completedOn: string;
  postExpense: boolean;
};

type TicketRow = {
  id: string;
  org_id: string;
  property_id: string;
  unit_id: string | null;
  title: string;
  status: string;
  currency: string | null;
  property_currency: string;
  vendor_name: string | null;
  estimated_cost_minor: string | null;
  final_cost_minor: string | null;
  cost_bearer: string;
  scheduled_on: string | null;
  completed_on: string | null;
  expense_id: string | null;
};

function assertTicketActor(session: Session) {
  if (session.kind === "staff") {
    assertPerm(session, "tickets.update");
    return;
  }
  if (session.kind !== "tenant") throw new FlowError("errors.forbidden");
}

async function loadTicket(client: Client, ticketId: string, orgId: string) {
  if (!isUuid(ticketId)) return null;
  return maybe<TicketRow>(
    client,
    `SELECT t.id::text, t.org_id::text, t.property_id::text, t.unit_id::text, t.title, t.status::text,
            t.currency, p.currency AS property_currency, t.vendor_name,
            t.estimated_cost_minor::text, t.final_cost_minor::text, t.cost_bearer::text,
            t.scheduled_on::text, t.completed_on::text, t.expense_id::text
       FROM maintenance_tickets t
       JOIN properties p ON p.id = t.property_id
      WHERE t.id = $1 AND t.org_id = $2`,
    [ticketId, orgId],
  );
}

async function openDay(client: Client, orgId: string) {
  const closed = await maybe<{ m: string | null }>(
    client,
    `SELECT max(period_month)::text AS m FROM month_closes WHERE org_id = $1`,
    [orgId],
  );
  const today = taipeiToday();
  if (!closed?.m) return today;
  const closedMonth = closed.m.slice(0, 7);
  if (today.slice(0, 7) > closedMonth) return today;
  const [year, month] = closedMonth.split("-").map(Number);
  const nextYear = month === 12 ? year + 1 : year;
  const nextMonth = month === 12 ? 1 : month + 1;
  return `${nextYear}-${String(nextMonth).padStart(2, "0")}-01`;
}

function incurredOn(preferred: string | null, firstOpen: string) {
  const day = preferred || firstOpen;
  return day.slice(0, 7) < firstOpen.slice(0, 7) ? firstOpen : day;
}

async function insertTimeline(
  client: Client,
  input: {
    orgId: string;
    ticketId: string;
    userId: string;
    body: string | null;
    internal: boolean;
    statusFrom: string | null;
    statusTo: string | null;
  },
) {
  if (!input.body && !input.statusTo) return;
  await client.query(
    `INSERT INTO ticket_comments (org_id, ticket_id, author_user_id, body, is_internal, status_from, status_to)
     VALUES ($1,$2,$3,$4,$5,$6::ticket_status,$7::ticket_status)`,
    [input.orgId, input.ticketId, input.userId, input.body, input.internal, input.statusFrom, input.statusTo],
  );
}

export async function saveRepairRecord(session: Session, ticketId: string, input: RepairInput) {
  assertPerm(session, "tickets.update");
  assertTicketStatus(input.status);
  assertCostBearer(input.costBearer || "undecided");
  const vendorName = cleanVendorName(input.vendorName);
  const estimated = parseOptionalMoney(input.estimated);
  const finalCost = parseOptionalMoney(input.finalCost);
  const scheduledOn = parseOptionalDate(input.scheduledOn);
  const requestedCompleted = parseOptionalDate(input.completedOn);
  const completedOn = completionDate(input.status, requestedCompleted, taipeiToday());
  datesInOrder(scheduledOn, completedOn);
  const note = input.note.trim() || null;
  if (input.postExpense && !can(session.role, "exp.add")) throw new FlowError("errors.forbidden");

  await tx(session.userId, async (client) => {
    const ticket = await loadTicket(client, ticketId, session.orgId);
    if (!ticket) throw new FlowError("errors.notFound");
    const existingExpense = ticket.expense_id
      ? ticket.expense_id
      : (
          await maybe<{ id: string }>(
            client,
            `SELECT id::text FROM expenses
              WHERE org_id = $1 AND ticket_id = $2 AND status <> 'void'
              ORDER BY created_at
              LIMIT 1`,
            [session.orgId, ticket.id],
          )
        )?.id ?? null;
    const link = expenseLinkPlan({
      post: input.postExpense,
      finalMinor: finalCost,
      expenseId: existingExpense,
      canPost: can(session.role, "exp.add"),
    });

    const vendor = vendorName
      ? await maybe<{ id: string }>(
          client,
          `SELECT id::text FROM contacts
            WHERE org_id = $1 AND is_vendor AND archived_at IS NULL AND display_name = $2
            ORDER BY created_at
            LIMIT 1`,
          [session.orgId, vendorName],
        )
      : null;
    const currency = estimated !== null || finalCost !== null ? ticket.property_currency : ticket.currency;

    await client.query(
      `UPDATE maintenance_tickets
          SET status = $3::ticket_status,
              vendor_name = $4,
              assigned_vendor_contact_id = $5::uuid,
              estimated_cost_minor = $6,
              final_cost_minor = $7,
              currency = $8,
              cost_bearer = $9::cost_bearer,
              scheduled_on = $10::date,
              completed_on = $11::date,
              resolved_at = CASE
                WHEN $3::ticket_status IN ('resolved','closed') THEN coalesce(resolved_at, now())
                ELSE resolved_at END,
              closed_at = CASE
                WHEN $3::ticket_status = 'closed' THEN coalesce(closed_at, now())
                ELSE closed_at END
        WHERE id = $1 AND org_id = $2`,
      [
        ticket.id,
        session.orgId,
        input.status,
        vendorName,
        vendor?.id ?? null,
        estimated,
        finalCost,
        currency,
        input.costBearer || "undecided",
        scheduledOn,
        completedOn,
      ],
    );

    const statusChanged = input.status !== ticket.status;
    if (statusChanged) {
      await insertTimeline(client, {
        orgId: session.orgId,
        ticketId: ticket.id,
        userId: session.userId,
        body: input.internal ? null : note,
        internal: false,
        statusFrom: ticket.status,
        statusTo: input.status,
      });
    }
    if (note && (input.internal || !statusChanged)) {
      await insertTimeline(client, {
        orgId: session.orgId,
        ticketId: ticket.id,
        userId: session.userId,
        body: note,
        internal: input.internal,
        statusFrom: null,
        statusTo: null,
      });
    }

    if (link === "skip") return;
    if (link === "keep") {
      if (existingExpense && existingExpense !== ticket.expense_id) {
        await client.query(`UPDATE maintenance_tickets SET expense_id = $2 WHERE id = $1 AND org_id = $3`, [
          ticket.id,
          existingExpense,
          session.orgId,
        ]);
      }
      return;
    }

    const day = incurredOn(completedOn || scheduledOn, await openDay(client, session.orgId));
    const expense = await one<{ id: string }>(
      client,
      `INSERT INTO expenses (
         org_id, property_id, unit_id, ticket_id, vendor_contact_id,
         category, description, currency, amount_minor, incurred_on,
         paid_by, bill_to, status, created_by
       ) VALUES (
         $1,$2,$3,$4,$5,
         'repair',$6,$7,$8,$9::date,
         'manager_firm',$10::cost_bearer,'draft',$11
       ) RETURNING id`,
      [
        session.orgId,
        ticket.property_id,
        ticket.unit_id,
        ticket.id,
        vendor?.id ?? null,
        ticket.title,
        currency || ticket.property_currency,
        finalCost,
        day,
        input.costBearer || "owner",
        session.userId,
      ],
    );
    await client.query(`UPDATE maintenance_tickets SET expense_id = $2 WHERE id = $1 AND org_id = $3`, [
      ticket.id,
      expense.id,
      session.orgId,
    ]);
  });
}

export async function addTicketComment(session: Session, ticketId: string, body: string, internal: boolean) {
  const note = body.trim();
  if (!note) throw new FlowError("errors.required");
  if (internal && session.kind !== "staff") throw new FlowError("errors.forbidden");
  assertTicketActor(session);
  if (!isUuid(ticketId)) throw new FlowError("errors.notFound");
  await tx(session.userId, async (client) => {
    const ticket = await maybe<{ id: string; org_id: string }>(
      client,
      `SELECT id::text, org_id::text FROM maintenance_tickets WHERE id = $1 AND org_id = $2`,
      [ticketId, session.orgId],
    );
    if (!ticket) throw new FlowError("errors.notFound");
    await insertTimeline(client, {
      orgId: ticket.org_id,
      ticketId: ticket.id,
      userId: session.userId,
      body: note,
      internal: session.kind === "staff" && internal,
      statusFrom: null,
      statusTo: null,
    });
  });
}

export async function repairPhotoTarget(session: Session, ticketId: string) {
  assertTicketActor(session);
  if (!isUuid(ticketId)) return null;
  return tx(session.userId, async (client) =>
    maybe<{ org_id: string; count: string }>(
      client,
      `SELECT t.org_id::text,
              (SELECT count(*)::text FROM ticket_attachments a WHERE a.ticket_id = t.id) AS count
         FROM maintenance_tickets t
        WHERE t.id = $1 AND t.org_id = $2`,
      [ticketId, session.orgId],
    ),
  );
}

/**
 * Records the storage object. Bytes stay in the private bucket; this inserts
 * the files and ticket_attachments rows only.
 */
export async function attachRepairPhoto(
  session: Session,
  input: { ticketId: string; path: string; fileName: string; mime: string; size: number; internal: boolean },
) {
  assertTicketActor(session);
  if (input.internal && session.kind !== "staff") throw new FlowError("errors.forbidden");
  const meta = assertPhotoMeta(input);
  const accepted = acceptPhotoObject({ size: input.size, mime: input.mime }, meta.mime);
  if (!isUuid(input.ticketId)) throw new FlowError("errors.notFound");
  const fileId = photoFileId(input.path);
  if (!fileId) throw new FlowError("errors.forbidden");

  return tx(session.userId, async (client) => {
    const ticket = await maybe<{ id: string; org_id: string }>(
      client,
      `SELECT id::text, org_id::text FROM maintenance_tickets WHERE id = $1 AND org_id = $2`,
      [input.ticketId, session.orgId],
    );
    if (!ticket) throw new FlowError("errors.notFound");
    if (!isTicketPhotoPath(input.path, ticket.org_id, ticket.id)) throw new FlowError("errors.forbidden");

    const existing = await maybe<{ id: string }>(
      client,
      `SELECT a.id::text
         FROM ticket_attachments a
         JOIN files f ON f.id = a.file_id
        WHERE a.ticket_id = $1 AND f.storage_path = $2 AND f.storage_bucket = $3`,
      [ticket.id, input.path, PHOTO_BUCKET],
    );
    if (existing) return existing.id;

    const count = await one<{ n: string }>(
      client,
      `SELECT count(*)::text AS n FROM ticket_attachments WHERE ticket_id = $1`,
      [ticket.id],
    );
    if (Number(count.n) >= PHOTO_LIMIT) throw new FlowError("errors.photoLimit");

    await client.query(
      `INSERT INTO files (id, org_id, storage_bucket, storage_path, file_name, mime_type, size_bytes, uploaded_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [fileId, ticket.org_id, PHOTO_BUCKET, input.path, meta.fileName, accepted.mime, accepted.size, session.userId],
    );
    const attachment = await one<{ id: string }>(
      client,
      `INSERT INTO ticket_attachments (org_id, ticket_id, file_id, is_internal)
       VALUES ($1,$2,$3,$4) RETURNING id::text`,
      [ticket.org_id, ticket.id, fileId, session.kind === "staff" && input.internal],
    );
    return attachment.id;
  });
}

export function newPhotoFileId() {
  return randomUUID();
}
