import type { Client } from "pg";
import { writeAudit } from "./audit";
import { maybe, svc, tx } from "./db";
import { insertPostedRepairExpense } from "./expenses";
import { FlowError } from "./errors";
import { loadOrgCountry } from "./org-country";
import { assertPerm } from "./perms";
import { portalInviteOrigin } from "./portal-invite";
import { taipeiToday } from "./money";
import {
  PHOTO_BUCKET,
  PHOTO_LIMIT,
  acceptPhotoObject,
  assertPhotoMeta,
  isTicketPhotoPath,
  isUuid,
  photoFileId,
  ticketPhotoPath,
} from "./repair-rules";
import { newPhotoFileId } from "./repairs";
import {
  inspectRepairObject,
  issueVendorUploadGrant,
  removeRepairObject,
  signRepairUpload,
  signTicketPhotoUrls,
  vendorUploadGrantMatches,
} from "./ticket-photos";
import type { Session } from "./types";
import {
  VENDOR_LINK_DAYS,
  cleanContactWindow,
  dispatchableTicket,
  displayVendorPhone,
  hashVendorToken,
  newVendorToken,
  reportableTicket,
  vendorCompletedOn,
  vendorCostMinor,
  vendorDispatchEnabled,
  vendorJobPath,
  vendorName,
  vendorPhone,
  vendorTokenAcceptable,
} from "./vendor-repair-rules";

type OpenJob = {
  job_id: string;
  org_id: string;
  ticket_id: string;
  vendor_name: string;
  contact_window: string;
  expires_at: string;
  reported_at: string | null;
  reported_cost_minor: string | null;
};

type TicketRow = {
  id: string;
  status: string;
  title: string;
  property_id: string;
  unit_id: string | null;
  scheduled_on: string | null;
  currency: string | null;
  property_currency: string;
  expense_id: string | null;
};

export type VendorDispatchView = {
  jobId: string;
  vendorName: string;
  phone: string;
  window: string;
  expiresAt: string;
  link: string;
  linkOpen: boolean;
  reported: boolean;
  reportedCost: string | null;
  confirmed: boolean;
  revoked: boolean;
  expenseId: string | null;
};

export type VendorJobPage = {
  title: string;
  description: string;
  address: string;
  place: string;
  window: string;
  currency: string;
  reported: boolean;
  issuePhotos: { id: string; name: string }[];
  donePhotos: { id: string; name: string }[];
};

export function vendorJobUrl(origin: string, token: string) {
  return `${portalInviteOrigin(origin)}${vendorJobPath(token)}`;
}

export async function orgVendorDispatchEnabled(orgId: string) {
  const row = await svc(null, (client) =>
    maybe<{ environment: string; plan_tier: string; feature_flags: unknown }>(
      client,
      `SELECT environment::text, plan_tier::text, feature_flags
         FROM organizations WHERE id = $1`,
      [orgId],
    ),
  );
  if (!row) return false;
  return vendorDispatchEnabled({
    environment: row.environment,
    planTier: row.plan_tier,
    featureFlags: row.feature_flags,
  });
}

async function assertDispatchFlag(client: Client, orgId: string) {
  const row = await maybe<{ ok: boolean }>(client, `SELECT app.vendor_dispatch_enabled($1::uuid) AS ok`, [orgId]);
  if (!row?.ok) throw new FlowError("errors.forbidden");
}

function assertStaff(session: Session) {
  if (session.kind !== "staff") throw new FlowError("errors.forbidden");
}

async function forgetClosedSecret(client: Client, hash: string) {
  await client.query(
    `DELETE FROM repair_vendor_secrets s
      USING repair_vendor_jobs j
      WHERE s.job_id = j.id
        AND j.token_hash = $1
        AND (j.revoked_at IS NOT NULL OR NOT j.active OR j.expires_at <= now())`,
    [hash],
  );
}

async function openJob(token: string) {
  if (!vendorTokenAcceptable(token)) return null;
  const hash = hashVendorToken(token);
  return svc(null, async (client) => {
    await forgetClosedSecret(client, hash);
    return maybe<OpenJob>(
      client,
      `SELECT job_id::text, org_id::text, ticket_id::text, vendor_name, contact_window,
              expires_at::text, reported_at::text, reported_cost_minor::text
         FROM app.open_vendor_job($1)`,
      [hash],
    );
  });
}

async function loadTicket(client: Client, ticketId: string, orgId: string) {
  if (!isUuid(ticketId)) return null;
  return maybe<TicketRow>(
    client,
    `SELECT t.id::text, t.status::text, t.title, t.property_id::text, t.unit_id::text,
            t.scheduled_on::text, t.currency, p.currency AS property_currency, t.expense_id::text
       FROM maintenance_tickets t
       JOIN properties p ON p.id = t.property_id
      WHERE t.id = $1 AND t.org_id = $2
      FOR UPDATE OF t`,
    [ticketId, orgId],
  );
}

async function vendorContact(client: Client, orgId: string, name: string, phone: string) {
  const existing = await maybe<{ id: string }>(
    client,
    `SELECT id::text FROM contacts
      WHERE org_id = $1 AND is_vendor AND archived_at IS NULL AND display_name = $2
      ORDER BY created_at
      LIMIT 1`,
    [orgId, name],
  );
  if (existing) return existing.id;
  const created = await maybe<{ id: string }>(
    client,
    `INSERT INTO contacts (org_id, is_vendor, display_name, phone_e164)
     VALUES ($1, true, $2, $3) RETURNING id::text`,
    [orgId, name, phone],
  );
  return created?.id ?? null;
}

async function noteStatus(client: Client, orgId: string, ticketId: string, userId: string | null, from: string, to: string) {
  if (from === to) return;
  await client.query(
    `INSERT INTO ticket_comments (org_id, ticket_id, author_user_id, status_from, status_to)
     VALUES ($1,$2,$3,$4::ticket_status,$5::ticket_status)`,
    [orgId, ticketId, userId, from, to],
  );
}

export async function dispatchVendor(
  session: Session,
  ticketId: string,
  input: { vendorName: string; vendorPhone: string; contactWindow: string },
  origin: string,
) {
  assertStaff(session);
  assertPerm(session, "tickets.update");
  if (!isUuid(ticketId)) throw new FlowError("errors.notFound");
  if (!(await orgVendorDispatchEnabled(session.orgId))) throw new FlowError("errors.forbidden");
  const country = await loadOrgCountry(session.orgId);
  const name = vendorName(input.vendorName);
  const phone = vendorPhone(input.vendorPhone, country.callingCode);
  const window = cleanContactWindow(input.contactWindow);
  const token = newVendorToken();
  const hash = hashVendorToken(token);

  const visible = await tx(session.userId, (client) =>
    maybe<{ id: string }>(client, `SELECT id::text FROM maintenance_tickets WHERE id = $1 AND org_id = $2`, [
      ticketId,
      session.orgId,
    ]),
  );
  if (!visible) throw new FlowError("errors.notFound");

  const jobId = await svc(session.userId, async (client) => {
    await assertDispatchFlag(client, session.orgId);
    const ticket = await loadTicket(client, ticketId, session.orgId);
    if (!ticket) throw new FlowError("errors.notFound");
    const current = await maybe<{
      id: string;
      reported: boolean;
      confirmed: boolean;
      revoked: boolean;
      expired: boolean;
    }>(
      client,
      `SELECT id::text,
              reported_at IS NOT NULL AS reported,
              confirmed_at IS NOT NULL AS confirmed,
              revoked_at IS NOT NULL AS revoked,
              expires_at <= now() AS expired
         FROM repair_vendor_jobs
        WHERE ticket_id = $1 AND org_id = $2 AND active
        FOR UPDATE`,
      [ticket.id, session.orgId],
    );
    if (current?.confirmed || current?.reported) throw new FlowError("errors.expenseState");
    if (!dispatchableTicket(ticket.status)) throw new FlowError("errors.notFound");
    if (current && !current.revoked && !current.expired) throw new FlowError("errors.forbidden");
    if (current) {
      await client.query(`UPDATE repair_vendor_jobs SET active = false WHERE id = $1 AND org_id = $2`, [
        current.id,
        session.orgId,
      ]);
    }
    const contactId = await vendorContact(client, session.orgId, name, phone);
    const job = await maybe<{ id: string }>(
      client,
      `INSERT INTO repair_vendor_jobs (
         org_id, ticket_id, vendor_name, vendor_phone, contact_window, token_hash, expires_at, created_by
       ) VALUES (
         $1,$2,$3,$4,$5,$6, now() + make_interval(days => $7), $8
       ) RETURNING id::text`,
      [session.orgId, ticket.id, name, phone, window, hash, VENDOR_LINK_DAYS, session.userId],
    );
    if (!job) throw new FlowError("errors.generic");
    await client.query(`INSERT INTO repair_vendor_secrets (job_id, token) VALUES ($1,$2)`, [job.id, token]);
    const nextStatus = ticket.status === "open" || ticket.status === "triaged" ? "assigned" : ticket.status;
    await client.query(
      `UPDATE maintenance_tickets
          SET vendor_name = $3,
              assigned_vendor_contact_id = $4::uuid,
              status = $5::ticket_status
        WHERE id = $1 AND org_id = $2`,
      [ticket.id, session.orgId, name, contactId, nextStatus],
    );
    await noteStatus(client, session.orgId, ticket.id, session.userId, ticket.status, nextStatus);
    await writeAudit(session.orgId, session.userId, "repair_dispatch", { ticketId: ticket.id, jobId: job.id, vendorName: name }, client);
    return job.id;
  });

  return { jobId, url: vendorJobUrl(origin, token) };
}

export async function revokeVendorJob(session: Session, ticketId: string, jobId: string) {
  assertStaff(session);
  assertPerm(session, "tickets.update");
  if (!isUuid(ticketId) || !isUuid(jobId)) throw new FlowError("errors.notFound");
  if (!(await orgVendorDispatchEnabled(session.orgId))) throw new FlowError("errors.forbidden");
  await svc(session.userId, async (client) => {
    await assertDispatchFlag(client, session.orgId);
    const updated = await client.query(
      `UPDATE repair_vendor_jobs
          SET revoked_at = now(), active = false
        WHERE id = $1 AND ticket_id = $2 AND org_id = $3
          AND active AND revoked_at IS NULL AND confirmed_at IS NULL`,
      [jobId, ticketId, session.orgId],
    );
    if (updated.rowCount !== 1) throw new FlowError("errors.notFound");
    await writeAudit(session.orgId, session.userId, "repair_dispatch_revoke", { ticketId, jobId }, client);
  });
}

export async function loadVendorDispatch(session: Session, ticketId: string, origin: string) {
  assertStaff(session);
  if (!isUuid(ticketId)) return null;
  if (!(await orgVendorDispatchEnabled(session.orgId))) return null;
  const job = await tx(session.userId, (client) =>
    maybe<{
      id: string;
      vendor_name: string;
      vendor_phone: string;
      contact_window: string;
      expires_at: string;
      link_open: boolean;
      reported: boolean;
      reported_cost: string | null;
      confirmed: boolean;
      revoked: boolean;
      expense_id: string | null;
    }>(
      client,
      `SELECT j.id::text, j.vendor_name, j.vendor_phone, j.contact_window, j.expires_at::text,
              (j.active AND j.revoked_at IS NULL AND j.expires_at > now()) AS link_open,
              j.reported_at IS NOT NULL AS reported,
              j.reported_cost_minor::text AS reported_cost,
              j.confirmed_at IS NOT NULL AS confirmed,
              j.revoked_at IS NOT NULL AS revoked,
              j.expense_id::text
         FROM repair_vendor_jobs j
        WHERE j.ticket_id = $1 AND j.org_id = $2
        ORDER BY j.created_at DESC
        LIMIT 1`,
      [ticketId, session.orgId],
    ),
  );
  if (!job) return { job: null as VendorDispatchView | null };
  let link = "";
  if (job.link_open) {
    const secret = await svc(session.userId, (client) =>
      maybe<{ token: string }>(
        client,
        `SELECT s.token
           FROM repair_vendor_secrets s
           JOIN repair_vendor_jobs j ON j.id = s.job_id
          WHERE s.job_id = $1 AND j.org_id = $2 AND j.ticket_id = $3
            AND j.active AND j.revoked_at IS NULL AND j.expires_at > now()`,
        [job.id, session.orgId, ticketId],
      ),
    );
    if (secret?.token) link = vendorJobUrl(origin, secret.token);
  }
  return {
    job: {
      jobId: job.id,
      vendorName: job.vendor_name,
      phone: displayVendorPhone(job.vendor_phone),
      window: job.contact_window,
      expiresAt: job.expires_at,
      link,
      linkOpen: job.link_open && link !== "",
      reported: job.reported,
      reportedCost: job.reported_cost,
      confirmed: job.confirmed,
      revoked: job.revoked,
      expenseId: job.expense_id,
    },
  };
}

export async function loadVendorJob(token: string): Promise<VendorJobPage | null> {
  const job = await openJob(token);
  if (!job) return null;
  return svc(null, async (client) => {
    const still = await maybe<{ job_id: string }>(client, `SELECT job_id::text FROM app.open_vendor_job($1)`, [
      hashVendorToken(token),
    ]);
    if (!still || still.job_id !== job.job_id) return null;
    const ticket = await maybe<{
      title: string;
      description: string | null;
      address: string;
      place: string;
      currency: string;
    }>(
      client,
      `SELECT t.title, t.description,
              coalesce(nullif(btrim(p.address_display), ''), p.name) AS address,
              btrim(coalesce(u.label, '') || ' ' || coalesce(r.label, '')) AS place,
              btrim(p.currency) AS currency
         FROM maintenance_tickets t
         JOIN properties p ON p.id = t.property_id AND p.org_id = t.org_id
         LEFT JOIN units u ON u.id = t.unit_id
         LEFT JOIN rooms r ON r.id = t.room_id
        WHERE t.id = $1 AND t.org_id = $2`,
      [job.ticket_id, job.org_id],
    );
    if (!ticket) return null;
    const photos = await client.query<{ id: string; name: string; vendor_job_id: string | null }>(
      `SELECT a.id::text, f.file_name AS name, a.vendor_job_id::text
         FROM ticket_attachments a
         JOIN files f ON f.id = a.file_id
        WHERE a.ticket_id = $1 AND a.org_id = $2 AND NOT a.is_internal
          AND (a.vendor_job_id IS NULL OR a.vendor_job_id = $3)
        ORDER BY a.created_at`,
      [job.ticket_id, job.org_id, job.job_id],
    );
    const issuePhotos = photos.rows.filter((row) => !row.vendor_job_id).map((row) => ({ id: row.id, name: row.name }));
    const donePhotos = photos.rows.filter((row) => row.vendor_job_id === job.job_id).map((row) => ({ id: row.id, name: row.name }));
    return {
      title: ticket.title,
      description: ticket.description ?? "",
      address: ticket.place ? `${ticket.address} ${ticket.place}` : ticket.address,
      place: ticket.place,
      window: job.contact_window,
      currency: ticket.currency,
      reported: Boolean(job.reported_at),
      issuePhotos,
      donePhotos,
    };
  });
}

export async function submitVendorReport(token: string, input: { done: boolean; cost: string }) {
  const opened = await openJob(token);
  if (!opened) throw new FlowError("errors.notFound");
  if (opened.reported_at) return;
  if (!input.done) throw new FlowError("errors.required");
  const cost = vendorCostMinor(input.cost);
  const today = taipeiToday();
  await svc(null, async (client) => {
    const job = await maybe<OpenJob>(
      client,
      `SELECT job_id::text, org_id::text, ticket_id::text, vendor_name, contact_window,
              expires_at::text, reported_at::text, reported_cost_minor::text
         FROM app.open_vendor_job($1)`,
      [hashVendorToken(token)],
    );
    if (!job || job.job_id !== opened.job_id) throw new FlowError("errors.notFound");
    if (job.reported_at) return;
    const ticket = await loadTicket(client, job.ticket_id, job.org_id);
    if (!ticket || !reportableTicket(ticket.status)) throw new FlowError("errors.notFound");
    const completed = vendorCompletedOn(ticket.scheduled_on, today);
    const currency = (ticket.currency || ticket.property_currency).trim();
    const updated = await client.query(
      `UPDATE repair_vendor_jobs
          SET reported_at = now(), reported_cost_minor = $2
        WHERE id = $1 AND org_id = $3
          AND active AND revoked_at IS NULL AND expires_at > now() AND reported_at IS NULL
          AND app.vendor_dispatch_enabled(org_id)`,
      [job.job_id, cost, job.org_id],
    );
    if (updated.rowCount !== 1) throw new FlowError("errors.notFound");
    await client.query(
      `UPDATE maintenance_tickets
          SET status = 'resolved'::ticket_status,
              final_cost_minor = $3,
              currency = $4,
              completed_on = $5::date,
              resolved_at = coalesce(resolved_at, now())
        WHERE id = $1 AND org_id = $2`,
      [ticket.id, job.org_id, cost, currency, completed],
    );
    await noteStatus(client, job.org_id, ticket.id, null, ticket.status, "resolved");
    await writeAudit(
      job.org_id,
      null,
      "repair_vendor_report",
      { ticketId: ticket.id, jobId: job.job_id, costMinor: cost },
      client,
    );
  });
}

export async function confirmVendorCost(session: Session, ticketId: string, jobId: string) {
  assertStaff(session);
  assertPerm(session, "tickets.update");
  assertPerm(session, "exp.add");
  if (!isUuid(ticketId) || !isUuid(jobId)) throw new FlowError("errors.notFound");
  if (!(await orgVendorDispatchEnabled(session.orgId))) throw new FlowError("errors.forbidden");
  await svc(session.userId, async (client) => {
    await assertDispatchFlag(client, session.orgId);
    const job = await maybe<{
      id: string;
      vendor_name: string;
      reported_cost: string | null;
      reported: boolean;
      confirmed: boolean;
    }>(
      client,
      `SELECT id::text, vendor_name, reported_cost_minor::text AS reported_cost,
              reported_at IS NOT NULL AS reported, confirmed_at IS NOT NULL AS confirmed
         FROM repair_vendor_jobs
        WHERE id = $1 AND ticket_id = $2 AND org_id = $3 AND active AND revoked_at IS NULL
        FOR UPDATE`,
      [jobId, ticketId, session.orgId],
    );
    if (!job || !job.reported || job.confirmed || !job.reported_cost) throw new FlowError("errors.notFound");
    const ticket = await loadTicket(client, ticketId, session.orgId);
    if (!ticket || !reportableTicket(ticket.status)) throw new FlowError("errors.notFound");
    const existing = await maybe<{ id: string }>(
      client,
      `SELECT id::text FROM expenses
        WHERE org_id = $1 AND ticket_id = $2 AND status <> 'void'
        LIMIT 1`,
      [session.orgId, ticket.id],
    );
    if (existing) throw new FlowError("errors.expenseState");
    const amount = Number(job.reported_cost);
    const today = taipeiToday();
    const incurredOn = vendorCompletedOn(ticket.scheduled_on, today);
    const currency = (ticket.currency || ticket.property_currency).trim();
    const posted = await insertPostedRepairExpense(client, session, {
      propertyId: ticket.property_id,
      unitId: ticket.unit_id,
      ticketId: ticket.id,
      vendorName: job.vendor_name,
      description: ticket.title,
      currency,
      amountCents: amount,
      incurredOn,
    });
    const nextStatus = ticket.status === "resolved" ? ticket.status : "resolved";
    await client.query(
      `UPDATE maintenance_tickets
          SET expense_id = $3::uuid,
              final_cost_minor = $4,
              currency = $5,
              cost_bearer = 'owner',
              status = $6::ticket_status,
              completed_on = COALESCE(completed_on, $7::date),
              resolved_at = coalesce(resolved_at, now())
        WHERE id = $1 AND org_id = $2`,
      [ticket.id, session.orgId, posted.expenseId, amount, currency, nextStatus, posted.incurred],
    );
    await client.query(
      `UPDATE repair_vendor_jobs
          SET confirmed_at = now(), confirmed_by = $4, expense_id = $3::uuid
        WHERE id = $1 AND org_id = $2 AND confirmed_at IS NULL`,
      [job.id, session.orgId, posted.expenseId, session.userId],
    );
    await noteStatus(client, session.orgId, ticket.id, session.userId, ticket.status, nextStatus);
    await writeAudit(
      session.orgId,
      session.userId,
      "repair_cost_confirm",
      { ticketId: ticket.id, jobId: job.id, expenseId: posted.expenseId, costMinor: amount },
      client,
    );
  });
}

async function photoCount(ticketId: string, orgId: string) {
  const row = await svc(null, (client) =>
    maybe<{ n: string }>(client, `SELECT count(*)::text AS n FROM ticket_attachments WHERE ticket_id = $1 AND org_id = $2`, [
      ticketId,
      orgId,
    ]),
  );
  return Number(row?.n ?? 0);
}

export async function prepareVendorPhoto(
  token: string,
  input: { fileName: string; mime: string; size: number },
) {
  const job = await openJob(token);
  if (!job) throw new FlowError("errors.notFound");
  const meta = assertPhotoMeta(input);
  if ((await photoCount(job.ticket_id, job.org_id)) >= PHOTO_LIMIT) throw new FlowError("errors.photoLimit");
  const path = ticketPhotoPath(job.org_id, job.ticket_id, newPhotoFileId(), meta.mime);
  const signed = await signRepairUpload(path);
  return {
    path,
    token: signed.token,
    uploadUrl: signed.uploadUrl,
    uploadToken: issueVendorUploadGrant(hashVendorToken(token), job.ticket_id, path),
  };
}

async function attachVendorPhoto(
  job: OpenJob,
  hash: string,
  input: { path: string; fileName: string; mime: string; size: number },
) {
  const fileId = photoFileId(input.path);
  if (!fileId) throw new FlowError("errors.forbidden");
  return svc(null, async (client) => {
    const still = await maybe<{ job_id: string }>(client, `SELECT job_id::text FROM app.open_vendor_job($1)`, [hash]);
    if (!still || still.job_id !== job.job_id) throw new FlowError("errors.notFound");
    const existing = await maybe<{ id: string }>(
      client,
      `SELECT a.id::text
         FROM ticket_attachments a
         JOIN files f ON f.id = a.file_id
        WHERE a.ticket_id = $1 AND a.org_id = $2 AND f.storage_path = $3`,
      [job.ticket_id, job.org_id, input.path],
    );
    if (existing) return existing.id;
    const count = await maybe<{ n: string }>(
      client,
      `SELECT count(*)::text AS n FROM ticket_attachments WHERE ticket_id = $1`,
      [job.ticket_id],
    );
    if (Number(count?.n ?? 0) >= PHOTO_LIMIT) throw new FlowError("errors.photoLimit");
    await client.query(
      `INSERT INTO files (id, org_id, storage_bucket, storage_path, file_name, mime_type, size_bytes)
       VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [fileId, job.org_id, PHOTO_BUCKET, input.path, input.fileName, input.mime, input.size],
    );
    const attachment = await maybe<{ id: string }>(
      client,
      `INSERT INTO ticket_attachments (org_id, ticket_id, file_id, is_internal, vendor_job_id)
       VALUES ($1,$2,$3,false,$4) RETURNING id::text`,
      [job.org_id, job.ticket_id, fileId, job.job_id],
    );
    if (!attachment) throw new FlowError("errors.generic");
    return attachment.id;
  });
}

const DISCARD = new Set(["errors.photoLimit", "errors.photoType", "errors.photoSize", "errors.photoStorage"]);

export async function confirmVendorPhoto(
  token: string,
  input: { path: string; fileName: string; mime: string; size: number; uploadToken: string },
) {
  const job = await openJob(token);
  if (!job) throw new FlowError("errors.notFound");
  if (!isTicketPhotoPath(input.path, job.org_id, job.ticket_id)) throw new FlowError("errors.forbidden");
  const hash = hashVendorToken(token);
  if (!vendorUploadGrantMatches(hash, job.ticket_id, input.path, input.uploadToken ?? "")) {
    throw new FlowError("errors.forbidden");
  }
  try {
    const meta = assertPhotoMeta({ fileName: input.fileName, mime: input.mime, size: input.size });
    const stored = await inspectRepairObject(input.path);
    const accepted = acceptPhotoObject({ size: stored.size, mime: stored.mime, header: stored.header }, meta.mime);
    return await attachVendorPhoto(job, hash, {
      path: input.path,
      fileName: meta.fileName,
      mime: accepted.mime,
      size: accepted.size,
    });
  } catch (error) {
    if (error instanceof FlowError && DISCARD.has(error.key)) {
      if (vendorUploadGrantMatches(hash, job.ticket_id, input.path, input.uploadToken ?? "")) {
        await removeRepairObject(input.path);
      }
    }
    throw error;
  }
}

export async function findVendorPhoto(token: string, attachmentId: string) {
  if (!isUuid(attachmentId)) return null;
  const job = await openJob(token);
  if (!job) return null;
  return svc(null, (client) =>
    maybe<{ name: string; mime: string | null; path: string }>(
      client,
      `SELECT f.file_name AS name, f.mime_type AS mime, f.storage_path AS path
         FROM ticket_attachments a
         JOIN files f ON f.id = a.file_id
        WHERE a.id = $1 AND a.ticket_id = $2 AND a.org_id = $3
          AND NOT a.is_internal
          AND (a.vendor_job_id IS NULL OR a.vendor_job_id = $4)`,
      [attachmentId, job.ticket_id, job.org_id, job.job_id],
    ),
  );
}

export async function openVendorPhoto(token: string, attachmentId: string) {
  const job = await openJob(token);
  if (!job) return null;
  const row = await findVendorPhoto(token, attachmentId);
  if (!row || !isTicketPhotoPath(row.path, job.org_id, job.ticket_id)) return null;
  const signed = await signTicketPhotoUrls(job.org_id, job.ticket_id, [row.path]);
  const url = signed[row.path];
  if (!url) return null;
  return { url, name: row.name, mime: row.mime || "application/octet-stream" };
}
