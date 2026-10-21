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
const JPEG = Uint8Array.of(0xff, 0xd8, 0xff, 0xe0);
const PNG = Uint8Array.of(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a);
const WEBP = Uint8Array.of(0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50);

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
    const vendorId = row.vendor_id;

    await saveRepairRecord(admin, ticketId, {
      status: "resolved",
      note: "",
      internal: false,
      vendorName: "臨時水電",
      estimated: "1500",
      finalCost: "1800",
      costBearer: "owner",
      scheduledOn: "2026-11-01",
      completedOn: "2026-11-03",
      postExpense: false,
    });
    const unmatched = await tx(USERS.admin, (client) =>
      client.query<{ vendor: string; vendor_id: string | null }>(
        `SELECT vendor_name AS vendor, assigned_vendor_contact_id::text AS vendor_id
           FROM maintenance_tickets WHERE id = $1`,
        [ticketId],
      ),
    );
    assert.equal(unmatched.rows[0].vendor, "臨時水電");
    assert.equal(unmatched.rows[0].vendor_id, vendorId);

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
    await assert.rejects(
      svc(null, (client) =>
        client.query(
          `INSERT INTO expenses (
             org_id, property_id, ticket_id, category, description, currency, amount_minor, incurred_on,
             paid_by, bill_to, status
           ) VALUES ($1,$2,$3,'repair','重複','TWD',100, current_date, 'manager_firm','owner','draft')`,
          [ORG, wang.property_id, ticketId],
        ),
      ),
    );

    await tx(USERS.admin, (client) =>
      client.query(`UPDATE expenses SET status = 'void' WHERE ticket_id = $1 AND status = 'draft'`, [ticketId]),
    );
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
    const afterVoid = await tx(USERS.admin, (client) =>
      client.query<{ status: string; linked: string; expense_id: string }>(
        `SELECT e.status::text, (e.id = t.expense_id) AS linked, t.expense_id::text
           FROM expenses e
           JOIN maintenance_tickets t ON t.id = e.ticket_id
          WHERE e.ticket_id = $1
          ORDER BY e.created_at`,
        [ticketId],
      ),
    );
    assert.deepEqual(
      afterVoid.rows.map((entry) => entry.status),
      ["void", "draft"],
    );
    assert.equal(afterVoid.rows[1].linked, true);

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
      storedMime: "image/jpeg",
      size: 2048,
      internal: false,
      header: JPEG,
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
      storedMime: "image/png",
      size: 100,
      internal: true,
      header: PNG,
    });
    const publicPath = ticketPhotoPath(ORG, ticketId, "40000000-0000-4000-8000-000000000096", "image/webp");
    await attachRepairPhoto(admin, {
      ticketId,
      path: publicPath,
      fileName: `${title}-public.webp`,
      mime: "image/webp",
      storedMime: "image/webp",
      size: 120,
      internal: false,
      header: WEBP,
    });
    await assert.rejects(
      attachRepairPhoto(admin, {
        ticketId,
        path: ticketPhotoPath(ORG, ticketId, "40000000-0000-4000-8000-000000000097", "image/jpeg"),
        fileName: "not-a-photo.jpg",
        mime: "image/jpeg",
        storedMime: "image/jpeg",
        size: 32,
        internal: false,
        header: Uint8Array.of(0x25, 0x50, 0x44, 0x46),
      }),
      (error: unknown) => error instanceof FlowError && error.key === "errors.photoType",
    );
    const tenantPhotos = await ticketDetail(wangSession, ticketId);
    assert.equal(tenantPhotos?.photos.length, 2);
    assert.ok(tenantPhotos?.photos.some((photo) => photo.name === `${title}-public.webp`));
    assert.equal(tenantPhotos?.photos.some((photo) => photo.internal), false);
    const staffPhotos = await ticketDetail(admin, ticketId);
    assert.equal(staffPhotos?.photos.length, 3);
    const tenantFile = await tx(USERS.tenant2, (client) =>
      client.query(`SELECT id FROM files WHERE storage_path = $1`, [publicPath]),
    );
    assert.equal(tenantFile.rowCount, 1);
    const hiddenFile = await tx(USERS.tenant2, (client) =>
      client.query(`SELECT id FROM files WHERE storage_path = $1`, [internalPath]),
    );
    assert.equal(hiddenFile.rowCount, 0);
    const otherTenantFile = await tx(USERS.tenant, (client) =>
      client.query(`SELECT id FROM files WHERE storage_path = $1`, [publicPath]),
    );
    assert.equal(otherTenantFile.rowCount, 0);

    for (let index = 0; index < 5; index += 1) {
      const fileId = `40000000-0000-4000-8000-0000000000${10 + index}`;
      await attachRepairPhoto(admin, {
        ticketId,
        path: ticketPhotoPath(ORG, ticketId, fileId, "image/jpeg"),
        fileName: `${title}-extra-${index}.jpg`,
        mime: "image/jpeg",
        storedMime: "image/jpeg",
        size: 80,
        internal: false,
        header: JPEG,
      });
    }
    await assert.rejects(
      attachRepairPhoto(admin, {
        ticketId,
        path: ticketPhotoPath(ORG, ticketId, "40000000-0000-4000-8000-00000000001f", "image/jpeg"),
        fileName: `${title}-ninth.jpg`,
        mime: "image/jpeg",
        storedMime: "image/jpeg",
        size: 80,
        internal: false,
        header: JPEG,
      }),
      (error: unknown) => error instanceof FlowError && error.key === "errors.photoLimit",
    );

    await assert.rejects(
      svc(null, (client) =>
        client.query(
          `INSERT INTO files (org_id, storage_bucket, storage_path, file_name, mime_type, size_bytes, uploaded_by)
           VALUES ($1,$2,$3,'too-big.jpg','image/jpeg',$4,$5)`,
          [ORG, PHOTO_BUCKET, `org/${ORG}/tickets/${ticketId}/too-big.jpg`, PHOTO_MAX_BYTES + 1, USERS.admin],
        ),
      ),
    );
    await assert.rejects(
      svc(null, (client) =>
        client.query(
          `INSERT INTO files (org_id, storage_bucket, storage_path, file_name, mime_type, size_bytes, uploaded_by)
           VALUES ($1,$2,$3,'anim.gif','image/gif',12,$4)`,
          [ORG, PHOTO_BUCKET, `org/${ORG}/tickets/${ticketId}/anim.gif`, USERS.admin],
        ),
      ),
    );
    const strayId = "40000000-0000-4000-8000-000000000095";
    const otherTicket = "50000000-0000-4000-8000-000000000001";
    await assert.rejects(
      svc(null, async (client) => {
        await client.query(
          `INSERT INTO files (id, org_id, storage_bucket, storage_path, file_name, mime_type, size_bytes, uploaded_by)
           VALUES ($1,$2,$3,$4,$5,'image/jpeg',100,$6)`,
          [strayId, ORG, PHOTO_BUCKET, `org/${ORG}/tickets/${otherTicket}/${strayId}.jpg`, `${title}-stray.jpg`, USERS.admin],
        );
        await client.query(
          `INSERT INTO ticket_attachments (org_id, ticket_id, file_id, is_internal) VALUES ($1,$2,$3,false)`,
          [ORG, ticketId, strayId],
        );
      }),
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
