import assert from "node:assert/strict";
import test from "node:test";
import { svc, tx } from "./db";
import { createTicket, updateTicket } from "./domain";
import { FlowError } from "./errors";
import { ORG_ID, USERS } from "./ids";
import { propertyDetail, tenantRepairs, ticketDetail } from "./queries";
import { PHOTO_BUCKET, PHOTO_MAX_BYTES, ticketPhotoPath } from "./repair-rules";
import { addTicketComment, attachRepairPhoto, saveRepairRecord } from "./repairs";
import type { Session } from "./types";

const ORG = ORG_ID;

function staff(userId: string, role: Session["role"]): Session {
  return {
    userId,
    sessionId: "repair",
    email: "staff@songxin.demo",
    name: "Staff",
    kind: "staff",
    role,
    orgId: ORG,
    liveOrgId: ORG,
    environment: "live",
    locale: "zh-TW",
    calendar: "gregorian",
    leaseId: null,
  };
}

function tenant(userId: string): Session {
  return {
    userId,
    sessionId: "repair-tenant",
    email: "tenant@demo",
    name: "租客",
    kind: "tenant",
    role: null,
    orgId: ORG,
    liveOrgId: ORG,
    environment: "live",
    locale: "zh-TW",
    calendar: "gregorian",
    leaseId: null,
  };
}

async function leaseFor(userId: string) {
  const row = await tx(USERS.admin, (client) =>
    client.query<{ id: string; property_id: string }>(
      `SELECT l.id::text, l.property_id::text
         FROM leases l
         JOIN lease_parties lp ON lp.lease_id = l.id
         JOIN contacts c ON c.id = lp.contact_id
        WHERE c.user_id = $1 AND l.org_id = $2 AND l.status = 'active'
        ORDER BY l.created_at
        LIMIT 1`,
      [userId, ORG],
    ),
  );
  return row.rows[0];
}

async function cleanup(titlePrefix: string) {
  await svc(null, async (client) => {
    const tickets = await client.query<{ id: string }>(
      `SELECT id FROM maintenance_tickets WHERE org_id = $1 AND title LIKE $2`,
      [ORG, `${titlePrefix}%`],
    );
    const ids = tickets.rows.map((row) => row.id);
    if (!ids.length) return;
    await client.query(`UPDATE maintenance_tickets SET expense_id = NULL WHERE id = ANY($1::uuid[])`, [ids]);
    await client.query(`DELETE FROM expenses WHERE org_id = $1 AND ticket_id = ANY($2::uuid[])`, [ORG, ids]);
    await client.query(`DELETE FROM maintenance_tickets WHERE id = ANY($1::uuid[])`, [ids]);
    await client.query(
      `DELETE FROM files WHERE org_id = $1 AND storage_bucket = $2 AND file_name LIKE $3`,
      [ORG, PHOTO_BUCKET, `${titlePrefix}%`],
    );
  });
}

test("tenants see only their own repairs; staff can record cost, vendor, dates, comments, photos, and a draft expense link", async () => {
  const title = `測試修繕${Date.now()}`;
  const wang = await leaseFor(USERS.tenant2);
  const zhang = await leaseFor(USERS.tenant);
  assert.ok(wang);
  assert.ok(zhang);
  const admin = staff(USERS.admin, "admin");
  const accountant = staff(USERS.accountant, "accountant");
  const wangSession = tenant(USERS.tenant2);
  const zhangSession = tenant(USERS.tenant);
  let ticketId = "";
  try {
    ticketId = await createTicket(wangSession, {
      leaseId: wang.id,
      category: "plumbing",
      title,
      description: "廚房漏水",
    });

    const own = await tx(USERS.tenant2, (client) =>
      client.query<{ n: string }>(`SELECT count(*)::text AS n FROM maintenance_tickets WHERE id = $1`, [ticketId]),
    );
    assert.equal(own.rows[0].n, "1");
    const otherTenant = await tx(USERS.tenant, (client) =>
      client.query(`SELECT id FROM maintenance_tickets WHERE id = $1`, [ticketId]),
    );
    assert.equal(otherTenant.rowCount, 0);
    const otherFirm = await tx(USERS.coastAdmin, (client) =>
      client.query(`SELECT id FROM maintenance_tickets WHERE id = $1`, [ticketId]),
    );
    assert.equal(otherFirm.rowCount, 0);
    const hiddenComment = await tx(USERS.tenant, (client) =>
      client.query(`SELECT id FROM ticket_comments WHERE ticket_id = $1`, [ticketId]),
    );
    assert.equal(hiddenComment.rowCount, 0);

    const opened = await ticketDetail(admin, ticketId);
    assert.ok(opened);
    assert.ok(opened.comments.some((comment) => comment.status_to === "open" && !comment.status_from));

    const costWrite = await tx(USERS.tenant2, (client) =>
      client.query(`UPDATE maintenance_tickets SET final_cost_minor = 100, currency = 'TWD' WHERE id = $1`, [ticketId]),
    );
    assert.equal(costWrite.rowCount, 0);
    await assert.rejects(
      tx(USERS.tenant2, (client) =>
        client.query(
          `INSERT INTO ticket_comments (org_id, ticket_id, author_user_id, status_to)
           VALUES ($1,$2,$3,'in_progress')`,
          [ORG, ticketId, USERS.tenant2],
        ),
      ),
    );

    await addTicketComment(wangSession, ticketId, "請盡快處理", false);
    await addTicketComment(admin, ticketId, "內部報價", true);
    const tenantView = await ticketDetail(wangSession, ticketId);
    assert.ok(tenantView);
    assert.ok(tenantView.comments.some((comment) => comment.body === "請盡快處理"));
    assert.equal(tenantView.comments.some((comment) => comment.body === "內部報價"), false);
    const staffView = await ticketDetail(admin, ticketId);
    assert.ok(staffView?.comments.some((comment) => comment.body === "內部報價" && comment.internal));

    await saveRepairRecord(admin, ticketId, {
      status: "resolved",
      note: "已更換龍頭",
      internal: false,
      vendorName: "老張水電",
      estimated: "1500",
      finalCost: "1800",
      costBearer: "owner",
      scheduledOn: "2026-11-01",
      completedOn: "2026-11-03",
      postExpense: true,
    });
    const saved = await tx(USERS.admin, (client) =>
      client.query<{
        vendor: string;
        vendor_id: string | null;
        estimated: string;
        final: string;
        scheduled: string;
        completed: string;
        status: string;
        expense_id: string;
        expense_status: string;
        expense_ticket: string;
        ledger: string | null;
        amount: string;
      }>(
        `SELECT t.vendor_name AS vendor, t.assigned_vendor_contact_id::text AS vendor_id,
                t.estimated_cost_minor::text AS estimated, t.final_cost_minor::text AS final,
                t.scheduled_on::text AS scheduled, t.completed_on::text AS completed, t.status::text,
                t.expense_id::text, e.status::text AS expense_status, e.ticket_id::text AS expense_ticket,
                e.ledger_transaction_id::text AS ledger, e.amount_minor::text AS amount
           FROM maintenance_tickets t
           JOIN expenses e ON e.id = t.expense_id
          WHERE t.id = $1`,
        [ticketId],
      ),
    );
    const row = saved.rows[0];
    assert.equal(row.vendor, "老張水電");
    assert.ok(row.vendor_id);
    assert.equal(row.estimated, "150000");
    assert.equal(row.final, "180000");
    assert.equal(row.scheduled, "2026-11-01");
    assert.equal(row.completed, "2026-11-03");
    assert.equal(row.status, "resolved");
    assert.equal(row.expense_status, "draft");
    assert.equal(row.expense_ticket, ticketId);
    assert.equal(row.ledger, null);
    assert.equal(row.amount, "180000");

    await saveRepairRecord(admin, ticketId, {
      status: "resolved",
      note: "",
      internal: false,
      vendorName: "老張水電",
      estimated: "1500",
      finalCost: "1800",
      costBearer: "owner",
      scheduledOn: "2026-11-01",
      completedOn: "2026-11-03",
      postExpense: true,
    });
    const expenses = await tx(USERS.admin, (client) =>
      client.query<{ n: string }>(`SELECT count(*)::text AS n FROM expenses WHERE ticket_id = $1 AND status <> 'void'`, [ticketId]),
    );
    assert.equal(expenses.rows[0].n, "1");

    const timeline = await ticketDetail(admin, ticketId);
    assert.ok(timeline?.comments.some((comment) => comment.status_from === "open" && comment.status_to === "resolved"));
    assert.ok(timeline?.comments.some((comment) => comment.body === "已更換龍頭"));

    const history = await propertyDetail(admin, wang.property_id);
    assert.ok(history?.repairs.some((repair) => repair.id === ticketId));
    const wangList = await tenantRepairs(wangSession, wang.id);
    assert.ok(wangList.some((repair) => repair.id === ticketId));
    const zhangList = await tenantRepairs(zhangSession, zhang.id);
    assert.equal(zhangList.some((repair) => repair.id === ticketId), false);
    assert.equal(await ticketDetail(zhangSession, ticketId), null);

    const fileId = "40000000-0000-4000-8000-000000000099";
    const path = ticketPhotoPath(ORG, ticketId, fileId, "image/jpeg");
    await attachRepairPhoto(wangSession, {
      ticketId,
      path,
      fileName: `${title}.jpg`,
      mime: "image/jpeg",
      size: 2048,
      internal: false,
    });
    const seen = await tx(USERS.tenant2, (client) =>
      client.query(`SELECT a.id FROM ticket_attachments a WHERE a.ticket_id = $1`, [ticketId]),
    );
    assert.equal(seen.rowCount, 1);
    const hiddenPhoto = await tx(USERS.tenant, (client) =>
      client.query(`SELECT id FROM ticket_attachments WHERE ticket_id = $1`, [ticketId]),
    );
    assert.equal(hiddenPhoto.rowCount, 0);

    const internalPath = ticketPhotoPath(ORG, ticketId, "40000000-0000-4000-8000-000000000098", "image/png");
    await attachRepairPhoto(admin, {
      ticketId,
      path: internalPath,
      fileName: `${title}-note.png`,
      mime: "image/png",
      size: 100,
      internal: true,
    });
    const tenantPhotos = await ticketDetail(wangSession, ticketId);
    assert.equal(tenantPhotos?.photos.length, 1);
    const staffPhotos = await ticketDetail(admin, ticketId);
    assert.equal(staffPhotos?.photos.length, 2);

    await assert.rejects(
      svc(null, (client) =>
        client.query(
          `INSERT INTO files (org_id, storage_bucket, storage_path, file_name, mime_type, size_bytes, uploaded_by)
           VALUES ($1,$2,$3,'too-big.jpg','image/jpeg',$4,$5)`,
          [ORG, PHOTO_BUCKET, `org/${ORG}/tickets/${ticketId}/too-big.jpg`, PHOTO_MAX_BYTES + 1, USERS.admin],
        ),
      ),
    );

    const accountantWrite = await tx(USERS.accountant, (client) =>
      client.query(`UPDATE maintenance_tickets SET vendor_name = '不該寫入' WHERE id = $1`, [ticketId]),
    );
    assert.equal(accountantWrite.rowCount, 0);
    await assert.rejects(saveRepairRecord(accountant, ticketId, {
      status: "closed",
      note: "",
      internal: false,
      vendorName: "不該寫入",
      estimated: "",
      finalCost: "1",
      costBearer: "owner",
      scheduledOn: "",
      completedOn: "",
      postExpense: false,
    }), (error: unknown) => error instanceof FlowError && error.key === "errors.forbidden");

    await updateTicket(admin, ticketId, { status: "closed", note: "結案" });
    const closed = await tx(USERS.admin, (client) =>
      client.query<{ status: string; completed: string }>(
        `SELECT status::text, completed_on::text AS completed FROM maintenance_tickets WHERE id = $1`,
        [ticketId],
      ),
    );
    assert.equal(closed.rows[0].status, "closed");
    assert.equal(closed.rows[0].completed, "2026-11-03");

    const staffTicket = await createTicket(admin, {
      leaseId: zhang.id,
      category: "other",
      title: `${title}-staff`,
      description: "事務所代報",
    });
    const zhangSeesStaff = await tx(USERS.tenant, (client) =>
      client.query(`SELECT id FROM maintenance_tickets WHERE id = $1`, [staffTicket]),
    );
    assert.equal(zhangSeesStaff.rowCount, 1);
    const wangMissesStaff = await tx(USERS.tenant2, (client) =>
      client.query(`SELECT id FROM maintenance_tickets WHERE id = $1`, [staffTicket]),
    );
    assert.equal(wangMissesStaff.rowCount, 0);
  } finally {
    await cleanup(title);
  }
});
