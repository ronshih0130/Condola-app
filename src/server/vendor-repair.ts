import type { Client } from "pg";
import { writeAudit } from "./audit";
import { repairApprovalsEnabled } from "./repair-approval";
import { assertIdentifiers } from "./repair-approval-rules";
import { maybe, svc, tx } from "./db";
import { insertPostedRepairExpense } from "./expenses";
import { FlowError } from "./errors";
import { loadOrgCountry } from "./org-country";
import { assertPerm, can } from "./perms";
import { admitTicketArchiveAncestry } from "./record-archive-admission";
import { portalInviteOrigin } from "./portal-invite";
import { taipeiToday } from "./money";
import {
  PHOTO_BUCKET,
  PHOTO_LIMIT,
  acceptPhotoObject,
  assertPhotoMeta,
  isTicketPhotoPath,
  cleanVendorTrade,
  isUuid,
  photoFileId,
  sniffPhotoMime,
  ticketPhotoPath,
} from "./repair-rules";
import { newPhotoFileId } from "./repairs";
import {
  downloadRepairObject,
  inspectRepairObject,
  issueVendorUploadGrant,
  removeRepairObject,
  signRepairUpload,
  signTicketPhotoUrls,
  vendorUploadGrantMatches,
} from "./ticket-photos";
import type { Session } from "./types";

async function currentDispatchActor(client:Client,session:Session) {
  if(session.kind!=='staff'||session.needsSandbox||!can(session.role,'tickets.update')||![session.userId,session.sessionId,session.orgId,session.liveOrgId].every(isUuid))throw new FlowError('errors.forbidden');
  const result=await client.query(`SELECT 1 FROM organizations o JOIN org_members m ON m.org_id=$2 AND m.user_id=$3 AND m.status='active' AND m.role::text=$4 JOIN auth_sessions a ON a.id=$5 AND a.user_id=$3 WHERE o.id=$1 AND o.environment::text=$6 AND ((o.environment='live' AND o.id=$2 AND o.live_org_id IS NULL) OR (o.environment='sandbox' AND o.live_org_id=$2)) AND a.revoked_at IS NULL AND a.expires_at>clock_timestamp()`,[session.orgId,session.liveOrgId,session.userId,session.role,session.sessionId,session.environment]);
  if(result.rowCount!==1)throw new FlowError('errors.forbidden');
}
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
  vendorCategory,
  vendorTokenAcceptable,
} from "./vendor-repair-rules";

import {
  VENDOR_LINK_ENABLED,
  renderableTypeFields,
  vendorLinkCapability,
  vendorLinkOn,
  vendorLinkSafeView,
  type VendorLinkCapability,
} from "./vendor-link-rules";
import { resolveVendorIdentity } from "./vendor-identity";
import { planVendorAttribution } from "./vendor-attribution";
import { requireOrgScope } from "./org-guard";

let vendorLinkKillSwitch: boolean = VENDOR_LINK_ENABLED;

/** Changes only the in-process kill switch; organization flags remain authoritative. */
export function __setVendorLinkKillSwitchForTests(on: boolean) {
  vendorLinkKillSwitch = on;
}

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
  assigned_vendor_contact_id: string | null;
};

export type VendorChoice = {
  id: string;
  name: string;
  trade: string;
  phone: string;
  /** YYYY-MM-DD of the latest repair for this vendor, computed from tickets. */
  lastOn: string | null;
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
  sharing?: { approved: boolean; photos: { id: string; name: string }[] };
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
  vendorLink?: {
    capability: VendorLinkCapability;
    sharingApproved: boolean;
    typeFields: Array<{ key: string; label: string; value: string }>;
  };
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

export async function currentRepairVersionId(client: Client, orgId: string, ticketId: string) {
  assertIdentifiers(orgId, ticketId);
  const row = await maybe<{ version_id: string | null }>(client,
    "SELECT h.current_version_id::text AS version_id"
    + " FROM app.b013_estimate_heads h WHERE h.org_id=$1::uuid AND h.ticket_id=$2::uuid",
    [orgId, ticketId],
  );
  if (row?.version_id) assertIdentifiers(row.version_id);
  return row?.version_id ?? null;
}

export async function repairDispatchAllowed(client: Client, orgId: string, versionId: string) {
  const row = await maybe<{ r: boolean }>(client,
    "SELECT app.b013_dispatch_allowed($1::uuid,$2::uuid) AS r",
    [orgId, versionId],
  );
  return row?.r === true;
}

async function vendorLinkEnabledOn(client: Client, orgId: string) {
  const row = await maybe<{ feature_flags: unknown }>(
    client,
    `SELECT feature_flags FROM organizations WHERE id = $1`,
    [orgId],
  );
  return vendorLinkOn(vendorLinkKillSwitch, row?.feature_flags);
}

export async function vendorLinkEnabledForOrg(orgId: string) {
  return svc(null, (client) => vendorLinkEnabledOn(client, orgId));
}

type LinkState = { active: boolean; revoked_at: string | null; expires_at: string };

/** Always lock the ticket before the assignment, then revalidate both flags and state. */
export async function lockTicketThenJobs(client: Client, orgId: string, ticketId: string) {
  const ticket = await maybe<{ id: string }>(
    client,
    `SELECT id::text FROM maintenance_tickets WHERE id = $1 AND org_id = $2 FOR UPDATE`,
    [ticketId, orgId],
  );
  if (!ticket) throw new FlowError("errors.notFound");
  await client.query(
    `SELECT id FROM repair_vendor_jobs
      WHERE ticket_id = $1 AND org_id = $2 ORDER BY id FOR UPDATE`,
    [ticketId, orgId],
  );
}

async function lockedVendorLink(client: Client, job: OpenJob, hash: string) {
  await lockTicketThenJobs(client, job.org_id, job.ticket_id);
  const ticket = await loadTicket(client, job.ticket_id, job.org_id);
  const state = await maybe<LinkState & {
    dispatch_enabled: boolean;
    sharing_approved_at: string | null;
    vendor_contact_id: string | null;
  }>(
    client,
    `SELECT active, revoked_at::text, expires_at::text, sharing_approved_at::text,
            vendor_contact_id::text,
            app.vendor_dispatch_enabled(org_id) AS dispatch_enabled
       FROM repair_vendor_jobs
      WHERE id = $1 AND ticket_id = $2 AND org_id = $3 AND token_hash = $4
        AND scope = 'case_collaboration'
      FOR UPDATE`,
    [job.job_id, job.ticket_id, job.org_id, hash],
  );
  if (!ticket || !state || !state.dispatch_enabled ||
      !state.vendor_contact_id || state.vendor_contact_id !== ticket.assigned_vendor_contact_id ||
      !(await vendorLinkEnabledOn(client, job.org_id))) {
    throw new FlowError("errors.notFound");
  }
  // Wall time matters after waiting for locks; SQL now() is transaction-start time.
  const capability = vendorLinkCapability({
    ticketStatus: ticket.status,
    active: state.active,
    revokedAt: state.revoked_at,
    expiresAt: state.expires_at,
    now: new Date(),
  });
  if (capability !== "write" || !state.sharing_approved_at) throw new FlowError("errors.notFound");
  return ticket;
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
            t.scheduled_on::text, t.currency, p.currency AS property_currency, t.expense_id::text,
            t.assigned_vendor_contact_id::text
       FROM maintenance_tickets t
       JOIN properties p ON p.id = t.property_id
      WHERE t.id = $1 AND t.org_id = $2
      FOR UPDATE OF t`,
    [ticketId, orgId],
  );
}

async function vendorContact(client: Client, orgId: string, name: string, phone: string, trade: string) {
  const existing = await maybe<{ id: string }>(
    client,
    `SELECT id::text FROM contacts
      WHERE org_id = $1 AND is_vendor AND archived_at IS NULL AND display_name = $2
      ORDER BY created_at
      LIMIT 1`,
    [orgId, name],
  );
  if (existing) {
    await client.query(
      `UPDATE contacts SET phone_e164 = $2, vendor_trade = $3, updated_at = now() WHERE id = $1 AND org_id = $4`,
      [existing.id, phone, trade, orgId],
    );
    return existing.id;
  }
  const created = await maybe<{ id: string }>(
    client,
    `INSERT INTO contacts (org_id, is_vendor, display_name, phone_e164, vendor_trade)
     VALUES ($1, true, $2, $3, $4) RETURNING id::text`,
    [orgId, name, phone, trade],
  );
  return created?.id ?? null;
}

async function vendorById(client: Client, orgId: string, vendorId: string) {
  return maybe<{ name: string; phone: string }>(
    client,
    `SELECT display_name AS name, phone_e164 AS phone
       FROM contacts
      WHERE id = $1 AND org_id = $2 AND is_vendor AND archived_at IS NULL`,
    [vendorId, orgId],
  );
}

async function noteStatus(client: Client, orgId: string, ticketId: string, userId: string | null, from: string, to: string) {
  if (from === to) return;
  await client.query(
    `INSERT INTO ticket_comments (org_id, ticket_id, author_user_id, status_from, status_to)
     VALUES ($1,$2,$3,$4::ticket_status,$5::ticket_status)`,
    [orgId, ticketId, userId, from, to],
  );
}

/** M04b. Saves name, category, and phone only. It does not dispatch a job. */
export async function addVendor(
  session: Session,
  ticketId: string,
  input: { name: string; phone: string; trade: string },
) {
  assertStaff(session);
  assertPerm(session, "tickets.update");
  if (!isUuid(ticketId)) throw new FlowError("errors.notFound");
  if (!(await orgVendorDispatchEnabled(session.orgId))) throw new FlowError("errors.forbidden");
  const country = await loadOrgCountry(session.orgId);
  const name = vendorName(input.name);
  const phone = vendorPhone(input.phone, country.callingCode);
  const trade = vendorCategory(input.trade);
  const visible = await tx(session.userId, (client) =>
    maybe<{ id: string }>(client, `SELECT id::text FROM maintenance_tickets WHERE id = $1 AND org_id = $2`, [
      ticketId,
      session.orgId,
    ]), requireOrgScope(session),
  );
  if (!visible) throw new FlowError("errors.notFound");
  const contactId = await svc(session.userId, async (client) => {
    await assertDispatchFlag(client, session.orgId);
    return vendorContact(client, session.orgId, name, phone, trade);
  });
  if (!contactId) throw new FlowError("errors.generic");
  return contactId;
}

export async function dispatchVendor(
  session: Session,
  ticketId: string,
  input: { vendorId?: string; vendorName: string; vendorPhone: string; vendorTrade?: string; contactWindow: string },
  origin: string,
) {
  assertStaff(session);
  assertPerm(session, "tickets.update");
  if (!isUuid(ticketId)) throw new FlowError("errors.notFound");
  if (!(await orgVendorDispatchEnabled(session.orgId))) throw new FlowError("errors.forbidden");
  const country = await loadOrgCountry(session.orgId);
  const rawName = input.vendorName.trim();
  const vendorId = (input.vendorId ?? "").trim();
  const name = rawName ? vendorName(rawName) : "";
  const phone = rawName ? vendorPhone(input.vendorPhone, country.callingCode) : "";
  if (!rawName && !isUuid(vendorId)) throw new FlowError("errors.required");
  const window = cleanContactWindow(input.contactWindow);
  const token = newVendorToken();
  const hash = hashVendorToken(token);

  const visible = await tx(session.userId, (client) =>
    maybe<{ id: string }>(client, `SELECT id::text FROM maintenance_tickets WHERE id = $1 AND org_id = $2`, [
      ticketId,
      session.orgId,
    ]), requireOrgScope(session),
  );
  if (!visible) throw new FlowError("errors.notFound");

  const jobId = await svc(session.userId, async (client) => {
    await currentDispatchActor(client,session);
    await assertDispatchFlag(client, session.orgId);
    await admitTicketArchiveAncestry(client, session.orgId, ticketId);
    await currentDispatchActor(client,session);
    await assertDispatchFlag(client,session.orgId);
    const enhanced = await vendorLinkEnabledOn(client, session.orgId);
    if (enhanced) await lockTicketThenJobs(client, session.orgId, ticketId);
    const ticket = await loadTicket(client, ticketId, session.orgId);
    await currentDispatchActor(client,session);
    await assertDispatchFlag(client,session.orgId);
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
    if (current && !current.revoked && !current.expired && !enhanced) throw new FlowError("errors.forbidden");
    if (current) {
      await client.query(enhanced
        ? `UPDATE repair_vendor_jobs
              SET active = false, revoked_at = coalesce(revoked_at, clock_timestamp()),
                  sharing_approved_at = NULL, sharing_approved_by = NULL, shared_description = NULL
            WHERE id = $1 AND org_id = $2`
        : `UPDATE repair_vendor_jobs SET active = false WHERE id = $1 AND org_id = $2`, [
        current.id,
        session.orgId,
      ]);
      if (enhanced) {
        await client.query(
          `DELETE FROM repair_vendor_job_shared_photos WHERE job_id = $1 AND org_id = $2`,
          [current.id, session.orgId],
        );
      }
    }
    let vendorNameSaved = name;
    let vendorPhoneSaved = phone;
    let contactId: string | null;
    if (rawName) {
      const trade = cleanVendorTrade(input.vendorTrade ?? "");
      contactId = await vendorContact(client, session.orgId, name, phone, trade);
    } else {
      const saved = await vendorById(client, session.orgId, vendorId);
      if (!saved?.phone) throw new FlowError("errors.required");
      vendorNameSaved = saved.name;
      vendorPhoneSaved = saved.phone;
      contactId = vendorId;
    }
    if (!contactId) throw new FlowError("errors.generic");
    const job = await maybe<{ id: string }>(
      client,
      `INSERT INTO repair_vendor_jobs (
         org_id, ticket_id, vendor_name, vendor_phone, contact_window, token_hash, expires_at, created_by,
         vendor_contact_id
       ) VALUES (
         $1,$2,$3,$4,$5,$6, now() + make_interval(days => $7), $8,$9
       ) RETURNING id::text`,
      [session.orgId, ticket.id, vendorNameSaved, vendorPhoneSaved, window, hash, VENDOR_LINK_DAYS, session.userId, contactId],
    );
    if (!job) throw new FlowError("errors.generic");
    await client.query(`INSERT INTO repair_vendor_secrets (job_id, token) VALUES ($1,$2)`, [job.id, token]);
    const nextStatus = ticket.status === "open" || ticket.status === "triaged" ? "assigned" : ticket.status;
    await client.query(
      `SELECT set_config('app.vendor_link_reassignment', $1, true)`,
      [enhanced ? "on" : "off"],
    );
    await client.query(
      `UPDATE maintenance_tickets
          SET vendor_name = $3,
              assigned_vendor_contact_id = $4::uuid,
              status = $5::ticket_status
        WHERE id = $1 AND org_id = $2`,
      [ticket.id, session.orgId, vendorNameSaved, contactId, nextStatus],
    );
    await noteStatus(client, session.orgId, ticket.id, session.userId, ticket.status, nextStatus);
    await writeAudit(session.orgId, session.userId, "repair_dispatch", { ticketId: ticket.id, jobId: job.id, vendorName: vendorNameSaved }, client);
    await currentDispatchActor(client,session);
    await assertDispatchFlag(client,session.orgId);
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
    if (await vendorLinkEnabledOn(client, session.orgId)) {
      await lockTicketThenJobs(client, session.orgId, ticketId);
    }
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

export async function approveVendorSharing(
  session: Session,
  ticketId: string,
  jobId: string,
  input: { description: string; attachmentIds: string[] },
) {
  assertStaff(session);
  assertPerm(session, "tickets.update");
  if (!isUuid(ticketId) || !isUuid(jobId)) throw new FlowError("errors.notFound");
  if (typeof input.description !== "string" || input.description.length > 10000 ||
      !Array.isArray(input.attachmentIds) || input.attachmentIds.length > PHOTO_LIMIT ||
      !input.attachmentIds.every((id) => typeof id === "string" && isUuid(id))) {
    throw new FlowError("errors.required");
  }
  const ids = [...new Set(input.attachmentIds)];
  await svc(session.userId, async (client) => {
    await assertDispatchFlag(client, session.orgId);
    if (!(await vendorLinkEnabledOn(client, session.orgId))) throw new FlowError("errors.forbidden");
    await lockTicketThenJobs(client, session.orgId, ticketId);
    const job = await maybe<{ id: string }>(
      client,
      `SELECT id::text FROM repair_vendor_jobs j
        WHERE id = $1 AND ticket_id = $2 AND org_id = $3
          AND scope = 'case_collaboration' AND active AND revoked_at IS NULL
          AND expires_at > clock_timestamp()
          AND EXISTS (
            SELECT 1 FROM maintenance_tickets t
             WHERE t.id = j.ticket_id AND t.org_id = j.org_id
               AND j.vendor_contact_id = t.assigned_vendor_contact_id)`,
      [jobId, ticketId, session.orgId],
    );
    if (!job) throw new FlowError("errors.notFound");
    const photos = await client.query<{ id: string }>(
      `SELECT id::text FROM ticket_attachments
        WHERE org_id = $1 AND ticket_id = $2 AND id = ANY($3::uuid[])
          AND NOT is_internal AND (vendor_job_id IS NULL OR vendor_job_id = $4)
        ORDER BY id FOR UPDATE`,
      [session.orgId, ticketId, ids, jobId],
    );
    if (photos.rows.length !== ids.length) throw new FlowError("errors.notFound");
    await client.query(
      "DELETE FROM repair_vendor_job_shared_photos WHERE org_id = $1 AND job_id = $2",
      [session.orgId, jobId],
    );
    await client.query(
      `INSERT INTO repair_vendor_job_shared_photos
         (org_id, job_id, attachment_id, approved_by, approved_at)
       SELECT $1, $2, id, $4, statement_timestamp() FROM unnest($3::uuid[]) AS selected(id)`,
      [session.orgId, jobId, ids, session.userId],
    );
    await client.query(
      `UPDATE repair_vendor_jobs SET shared_description = $4,
              sharing_approved_at = statement_timestamp(), sharing_approved_by = $5
        WHERE org_id = $1 AND ticket_id = $2 AND id = $3`,
      [session.orgId, ticketId, jobId, input.description.trim(), session.userId],
    );
    await writeAudit(session.orgId, session.userId, "repair_vendor_sharing_approve",
      { ticketId, jobId, attachmentIds: ids }, client);
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
    ), requireOrgScope(session),
  );
  const vendors = await tx(session.userId, (client) =>
    client.query<{ id: string; name: string; trade: string | null; phone: string | null; last_on: string | null }>(
      `SELECT c.id::text, c.display_name AS name, c.vendor_trade AS trade, c.phone_e164 AS phone,
              (
                SELECT to_char(
                         max(coalesce(t.completed_on, t.scheduled_on, (t.updated_at AT TIME ZONE 'Asia/Taipei')::date)),
                         'YYYY-MM-DD'
                       )
                  FROM maintenance_tickets t
                 WHERE t.org_id = c.org_id
                   AND t.assigned_vendor_contact_id = c.id
              ) AS last_on
         FROM contacts c
        WHERE c.org_id = $1 AND c.is_vendor AND c.archived_at IS NULL
        ORDER BY c.display_name`,
      [session.orgId],
    ), requireOrgScope(session),
  );
  const choices: VendorChoice[] = vendors.rows.map((row) => ({
    id: row.id,
    name: row.name,
    trade: row.trade ?? "",
    phone: row.phone ? displayVendorPhone(row.phone) : "",
    lastOn: row.last_on,
  }));
  if (!job) return { job: null as VendorDispatchView | null, vendors: choices };
  let link = "";
  if (can(session.role, "tickets.update") && job.link_open) {
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
  const sharing = can(session.role, "tickets.update")
    ? await svc(session.userId, async (client) => {
      if (!(await vendorLinkEnabledOn(client, session.orgId))) return undefined;
      const state = await maybe<{ approved: boolean }>(client,
        `SELECT sharing_approved_at IS NOT NULL AS approved FROM repair_vendor_jobs
          WHERE id = $1 AND ticket_id = $2 AND org_id = $3`,
        [job.id, ticketId, session.orgId]);
      const photos = await client.query<{ id: string; name: string }>(
        `SELECT a.id::text, f.file_name AS name FROM ticket_attachments a
           JOIN files f ON f.id = a.file_id AND f.org_id = a.org_id
          WHERE a.ticket_id = $1 AND a.org_id = $2 AND NOT a.is_internal
            AND (a.vendor_job_id IS NULL OR a.vendor_job_id = $3)
          ORDER BY a.created_at`, [ticketId, session.orgId, job.id]);
      return { approved: Boolean(state?.approved), photos: photos.rows };
    })
    : undefined;
  return {
    job: {
      jobId: job.id,
      ...(sharing ? { sharing } : {}),
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
    vendors: choices,
  };
}

export async function loadVendorJob(token: string): Promise<VendorJobPage | null> {
  const job = await openJob(token);
  if (!job) return null;
  return svc(null, async (client) => {
    const enhanced = await vendorLinkEnabledOn(client, job.org_id);
    if (enhanced) await lockTicketThenJobs(client, job.org_id, job.ticket_id);
    const still = await maybe<{ job_id: string }>(client, `SELECT job_id::text FROM app.open_vendor_job($1)`, [
      hashVendorToken(token),
    ]);
    if (!still || still.job_id !== job.job_id) return null;
    // Preserve the flag-OFF path: only enhanced loads invoke the resolver / planner.
    let resolution: Awaited<ReturnType<typeof resolveVendorIdentity>> = null;
    if (enhanced) {
      resolution = await resolveVendorIdentity({
        query: <T extends Record<string, unknown>>(query: string, params?: unknown[]) =>
          client.query<T>(query, params),
      }, { token, now: new Date(), linkedUserId: null });
      if (!resolution ||
          resolution.jobId !== job.job_id || resolution.orgId !== job.org_id ||
          resolution.ticketId !== job.ticket_id) return null;
    }
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
         JOIN files f ON f.id = a.file_id AND f.org_id = a.org_id
        WHERE a.ticket_id = $1 AND a.org_id = $2 AND NOT a.is_internal
          AND (a.vendor_job_id IS NULL OR a.vendor_job_id = $3)
          AND (NOT $4::boolean OR a.vendor_job_id = $3 OR EXISTS (
            SELECT 1 FROM repair_vendor_job_shared_photos s
             WHERE s.org_id = a.org_id AND s.job_id = $3 AND s.attachment_id = a.id))
        ORDER BY a.created_at`,
      [job.ticket_id, job.org_id, job.job_id, enhanced],
    );
    const issuePhotos = photos.rows.filter((row) => !row.vendor_job_id).map((row) => ({ id: row.id, name: row.name }));
    const donePhotos = photos.rows.filter((row) => row.vendor_job_id === job.job_id).map((row) => ({ id: row.id, name: row.name }));
    if (enhanced) {
      const state = await maybe<LinkState & { status: string; sharing_approved_at: string | null; shared_description: string | null }>(
        client,
        `SELECT t.status::text, j.active, j.revoked_at::text, j.expires_at::text,
                j.sharing_approved_at::text, j.shared_description
           FROM maintenance_tickets t
           JOIN repair_vendor_jobs j ON j.ticket_id = t.id AND j.org_id = t.org_id
          WHERE t.id = $1 AND t.org_id = $2 AND j.id = $3 AND j.token_hash = $4
            AND j.vendor_contact_id = t.assigned_vendor_contact_id
            AND j.scope = 'case_collaboration' AND app.vendor_dispatch_enabled(j.org_id)`,
        [job.ticket_id, job.org_id, job.job_id, hashVendorToken(token)],
      );
      if (!state) return null;
      const capability = vendorLinkCapability({
        ticketStatus: state.status,
        active: state.active,
        revokedAt: state.revoked_at,
        expiresAt: state.expires_at,
        now: new Date(),
      });
      if (capability === "invalid") return null;
      // PROP-10 r2 / V-13 ordering: plan attribution only after the post-state capability
      // recompute succeeds, so expiry during the read yields no plan. Still inert (void; no writes).
      if (resolution) void planVendorAttribution(resolution, null, new Date(), true);
      const sharingApproved = Boolean(state.sharing_approved_at);
      const safe = vendorLinkSafeView({
        title: "",
        description: sharingApproved ? state.shared_description ?? "" : "",
        address: sharingApproved ? (ticket.place ? `${ticket.address} ${ticket.place}` : ticket.address) : "",
        place: sharingApproved ? ticket.place : "",
        window: sharingApproved ? job.contact_window : "",
        status: state.status,
        expiresAt: state.expires_at,
        issuePhotos: sharingApproved ? issuePhotos : [],
        donePhotos: sharingApproved ? donePhotos : [],
      });
      return {
        ...safe,
        currency: ticket.currency,
        reported: Boolean(job.reported_at),
        vendorLink: { capability, sharingApproved, typeFields: renderableTypeFields(null, null) },
      };
    }
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
  const enhanced = await vendorLinkEnabledForOrg(opened.org_id);
  if (opened.reported_at && !enhanced) return;
  if (!input.done) throw new FlowError("errors.required");
  const cost = vendorCostMinor(input.cost);
  const today = taipeiToday();
  await svc(null, async (client) => {
    const lockedTicket = enhanced || await vendorLinkEnabledOn(client, opened.org_id)
      ? await lockedVendorLink(client, opened, hashVendorToken(token))
      : null;
    const job = await maybe<OpenJob>(
      client,
      `SELECT job_id::text, org_id::text, ticket_id::text, vendor_name, contact_window,
              expires_at::text, reported_at::text, reported_cost_minor::text
         FROM app.open_vendor_job($1)`,
      [hashVendorToken(token)],
    );
    if (!job || job.job_id !== opened.job_id) throw new FlowError("errors.notFound");
    if (job.reported_at) return;
    const ticket = lockedTicket ?? await loadTicket(client, job.ticket_id, job.org_id);
    if (!ticket || !reportableTicket(ticket.status)) throw new FlowError("errors.notFound");
    if (await orgVendorDispatchEnabled(job.org_id) && await repairApprovalsEnabled(job.org_id)) {
      const versionId = await currentRepairVersionId(client, job.org_id, job.ticket_id);
      if (!versionId || !(await repairDispatchAllowed(client, job.org_id, versionId))) {
        throw new FlowError("errors.forbidden");
      }
    }
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
    if (await vendorLinkEnabledOn(client, session.orgId)) {
      await lockTicketThenJobs(client, session.orgId, ticketId);
    }
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
    const nextStatus = "closed";
    await client.query(
      `UPDATE maintenance_tickets
          SET expense_id = $3::uuid,
              final_cost_minor = $4,
              currency = $5,
              cost_bearer = 'owner',
              status = $6::ticket_status,
              completed_on = COALESCE(completed_on, $7::date),
              resolved_at = coalesce(resolved_at, now()),
              closed_at = coalesce(closed_at, now())
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
  if (await vendorLinkEnabledForOrg(job.org_id)) {
    return svc(null, async (client) => {
      await lockedVendorLink(client, job, hashVendorToken(token));
      const meta = assertPhotoMeta(input);
      const count = await maybe<{ n: string }>(
        client,
        `SELECT count(*)::text AS n FROM ticket_attachments WHERE ticket_id = $1 AND org_id = $2`,
        [job.ticket_id, job.org_id],
      );
      if (Number(count?.n ?? 0) >= PHOTO_LIMIT) throw new FlowError("errors.photoLimit");
      const path = ticketPhotoPath(job.org_id, job.ticket_id, newPhotoFileId(), meta.mime);
      const signed = await signRepairUpload(path);
      return {
        path,
        token: signed.token,
        uploadUrl: signed.uploadUrl,
        uploadToken: issueVendorUploadGrant(hashVendorToken(token), job.ticket_id, path),
      };
    });
  }
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

async function lockVendorPhotoTicket(client: Client, job: OpenJob) {
  const ticket = await maybe<{ id: string }>(
    client,
    `SELECT id::text FROM maintenance_tickets WHERE id = $1 AND org_id = $2 FOR UPDATE`,
    [job.ticket_id, job.org_id],
  );
  if (!ticket) throw new FlowError("errors.notFound");
}

async function attachVendorPhoto(
  job: OpenJob,
  hash: string,
  input: { path: string; fileName: string; mime: string; size: number },
  enhanced: boolean,
) {
  const fileId = photoFileId(input.path);
  if (!fileId) throw new FlowError("errors.forbidden");
  return svc(null, async (client) => {
    await lockVendorPhotoTicket(client, job);
    if (enhanced || await vendorLinkEnabledOn(client, job.org_id)) {
      await lockedVendorLink(client, job, hash);
    }
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

const DISCARD = new Set(["errors.photoLimit", "errors.photoType", "errors.photoSize", "errors.photoStorage", "errors.photoHeic"]);

export async function confirmVendorPhoto(
  token: string,
  input: { path: string; fileName: string; mime: string; size: number; uploadToken: string },
  deps?: { remove?: typeof removeRepairObject },
) {
  const job = await openJob(token);
  if (!job) throw new FlowError("errors.notFound");
  const enhanced = await vendorLinkEnabledForOrg(job.org_id);
  if (enhanced) {
    await svc(null, (client) => lockedVendorLink(client, job, hashVendorToken(token)));
  }
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
    }, enhanced);
  } catch (error) {
    if (error instanceof FlowError && DISCARD.has(error.key)) {
      if (vendorUploadGrantMatches(hash, job.ticket_id, input.path, input.uploadToken ?? "")) {
        const existingId = await svc(null, async (client) => {
          await lockVendorPhotoTicket(client, job);
          if (enhanced || await vendorLinkEnabledOn(client, job.org_id)) {
            await lockedVendorLink(client, job, hash);
          }
          const reference = await maybe<{ id: string | null }>(
            client,
            `SELECT a.id::text
               FROM files f
               LEFT JOIN ticket_attachments a ON a.file_id = f.id
              WHERE f.storage_path = $1
              ORDER BY a.id NULLS LAST
              LIMIT 1`,
            [input.path],
          );
          if (reference) return reference.id;
          await (deps?.remove ?? removeRepairObject)(input.path);
          return null;
        });
        if (existingId) return existingId;
      }
    }
    throw error;
  }
}

export async function findVendorPhoto(token: string, attachmentId: string) {
  if (!isUuid(attachmentId)) return null;
  const job = await openJob(token);
  if (!job) return null;
  if (await vendorLinkEnabledForOrg(job.org_id)) return null;
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

/** Authorize and deliver private bytes in one transaction; never issue a storage URL. */
export async function streamVendorPhoto(token: string, attachmentId: string) {
  try {
    if (!isUuid(attachmentId)) return null;
    const job = await openJob(token);
    if (!job) return null;
    return await svc(null, async (client) => {
      if (!(await vendorLinkEnabledOn(client, job.org_id))) return null;
      await lockTicketThenJobs(client, job.org_id, job.ticket_id);
      const row = await maybe<LinkState & { status: string; path: string }>(
        client,
        `SELECT j.active, j.revoked_at::text, j.expires_at::text, t.status::text,
                f.storage_path AS path
           FROM repair_vendor_jobs j
           JOIN maintenance_tickets t ON t.id = j.ticket_id AND t.org_id = j.org_id
           JOIN ticket_attachments a ON a.ticket_id = t.id AND a.org_id = t.org_id
           JOIN files f ON f.id = a.file_id AND f.org_id = a.org_id
          WHERE j.id = $1 AND j.org_id = $2 AND j.ticket_id = $3 AND j.token_hash = $4
            AND j.vendor_contact_id = t.assigned_vendor_contact_id
            AND a.id = $5 AND NOT a.is_internal
            AND j.scope = 'case_collaboration' AND j.sharing_approved_at IS NOT NULL
            AND (a.vendor_job_id = j.id OR EXISTS (
              SELECT 1 FROM repair_vendor_job_shared_photos s
               WHERE s.org_id = a.org_id AND s.job_id = j.id AND s.attachment_id = a.id))
            AND (a.vendor_job_id IS NULL OR a.vendor_job_id = j.id)
            AND f.storage_bucket = $6 AND app.vendor_dispatch_enabled(j.org_id)`,
        [job.job_id, job.org_id, job.ticket_id, hashVendorToken(token), attachmentId, PHOTO_BUCKET],
      );
      if (!row || !isTicketPhotoPath(row.path, job.org_id, job.ticket_id)) return null;
      const valid = () => vendorLinkCapability({
        ticketStatus: row.status, active: row.active, revokedAt: row.revoked_at,
        expiresAt: row.expires_at, now: new Date(),
      }) !== "invalid";
      if (!valid()) return null;
      const bytes = await downloadRepairObject(row.path);
      const contentType = sniffPhotoMime(bytes);
      if (!contentType || !valid()) return null;
      return { bytes, contentType };
    });
  } catch {
    return null;
  }
}

export async function openVendorPhoto(token: string, attachmentId: string) {
  const job = await openJob(token);
  if (!job) return null;
  if (await vendorLinkEnabledForOrg(job.org_id)) return streamVendorPhoto(token, attachmentId);
  const row = await findVendorPhoto(token, attachmentId);
  if (!row || !isTicketPhotoPath(row.path, job.org_id, job.ticket_id)) return null;
  const signed = await signTicketPhotoUrls(job.org_id, job.ticket_id, [row.path]);
  const url = signed[row.path];
  if (!url) return null;
  return { url, name: row.name, mime: row.mime || "application/octet-stream" };
}
