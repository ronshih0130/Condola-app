import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { describe, test } from "node:test";
import { svc, tx, withClient } from "./db";
import { createTicket } from "./domain";
import { cancelTenantRepair } from "./repairs";
import { FlowError } from "./errors";
import { ORG_ID, ORG2_ID, USERS } from "./ids";
import { loadIncomeExpense } from "./income-expense";
import { PHOTO_BUCKET, ticketPhotoPath } from "./repair-rules";
import type { Session } from "./types";
import {
  addVendor,
  confirmVendorCost,
  dispatchVendor,
  findVendorPhoto,
  loadVendorDispatch,
  loadVendorJob,
  revokeVendorJob,
  submitVendorReport,
} from "./vendor-repair";
import { lastCooperationParts } from "./vendor-repair-rules";
import { hashVendorToken } from "./vendor-repair-rules";

const ORG = ORG_ID;
const PRO_ORG = "10000000-0000-4000-8000-0000000000a1";
const SANDBOX_ORG = "10000000-0000-4000-8000-0000000000a2";
const ORIGIN = "http://127.0.0.1:43123";

function staff(userId: string, role: Session["role"], orgId = ORG): Session {
  return {
    userId,
    sessionId: "vendor-repair",
    email: "staff@songxin.demo",
    name: "Staff",
    kind: "staff",
    role,
    orgId,
    liveOrgId: orgId,
    environment: "live",
    locale: "zh-TW",
    calendar: "gregorian",
    leaseId: null,
  };
}

function tenant(userId: string): Session {
  return {
    userId,
    sessionId: "vendor-tenant",
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

function tokenOf(url: string) {
  return decodeURIComponent(new URL(url).pathname.replace(/^\/v\//, ""));
}

async function leaseFor(userId: string) {
  const row = await tx(USERS.admin, (client) =>
    client.query<{ id: string }>(
      `SELECT l.id::text
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
  await withClient(async (client) => {
    const tickets = await client.query<{ id: string }>(
      `SELECT id FROM maintenance_tickets WHERE org_id = $1 AND title LIKE $2`,
      [ORG, `${titlePrefix}%`],
    );
    const ids = tickets.rows.map((row) => row.id);
    if (!ids.length) return;
    const expenses = await client.query<{ id: string; ledger: string | null }>(
      `SELECT id, ledger_transaction_id AS ledger FROM expenses WHERE org_id = $1 AND ticket_id = ANY($2::uuid[])`,
      [ORG, ids],
    );
    const expenseIds = expenses.rows.map((row) => row.id);
    const ledgerIds = expenses.rows.map((row) => row.ledger).filter((id): id is string => Boolean(id));
    await client.query(`UPDATE maintenance_tickets SET expense_id = NULL WHERE id = ANY($1::uuid[])`, [ids]);
    await client.query(`UPDATE repair_vendor_jobs SET expense_id = NULL WHERE ticket_id = ANY($1::uuid[])`, [ids]);
    if (expenseIds.length) {
      await client.query(`UPDATE expenses SET ledger_transaction_id = NULL WHERE id = ANY($1::uuid[])`, [expenseIds]);
    }
    if (ledgerIds.length) {
      await client.query(`ALTER TABLE ledger_entries DISABLE TRIGGER trg_ledger_entries_append_only`);
      await client.query(`ALTER TABLE ledger_transactions DISABLE TRIGGER trg_ledger_transactions_append_only`);
      try {
        await client.query(`DELETE FROM ledger_entries WHERE transaction_id = ANY($1::uuid[])`, [ledgerIds]);
        await client.query(`DELETE FROM ledger_transactions WHERE id = ANY($1::uuid[])`, [ledgerIds]);
      } finally {
        await client.query(`ALTER TABLE ledger_entries ENABLE TRIGGER trg_ledger_entries_append_only`);
        await client.query(`ALTER TABLE ledger_transactions ENABLE TRIGGER trg_ledger_transactions_append_only`);
      }
    }
    await client.query(`DELETE FROM repair_vendor_jobs WHERE ticket_id = ANY($1::uuid[])`, [ids]);
    if (expenseIds.length) await client.query(`DELETE FROM expenses WHERE id = ANY($1::uuid[])`, [expenseIds]);
    await client.query(`DELETE FROM maintenance_tickets WHERE id = ANY($1::uuid[])`, [ids]);
    await client.query(`DELETE FROM files WHERE org_id = $1 AND storage_bucket = $2 AND file_name LIKE $3`, [
      ORG,
      PHOTO_BUCKET,
      `${titlePrefix}%`,
    ]);
  });
}

async function dropFirms() {
  await svc(null, async (client) => {
    await client.query(`DELETE FROM organizations WHERE id = ANY($1::uuid[])`, [[SANDBOX_ORG, PRO_ORG]]);
  });
}

describe("vendor repair dispatch", { concurrency: false }, () => {
  test("permissions, expiry, revocation, and the owner expense", async () => {
    const title = `師傅派工${Date.now()}`;
    const wang = await leaseFor(USERS.tenant2);
    assert.ok(wang);
    const admin = staff(USERS.admin, "admin");
    const maintenance = staff(USERS.maintenance, "maintenance");
    const accountant = staff(USERS.accountant, "accountant");
    const coast = staff(USERS.coastAdmin, "admin", ORG2_ID);
    let ticketId = "";
    try {
      ticketId = await createTicket(tenant(USERS.tenant2), {
        leaseId: wang.id,
        category: "plumbing",
        title,
        description: "廚房漏水",
      });
      await assert.rejects(() => dispatchVendor(accountant, ticketId, { vendorName: "陳水電", vendorPhone: "0912000111", contactWindow: "週三 14:00-17:00" }, ORIGIN), (error: unknown) => {
        return error instanceof FlowError && error.key === "errors.forbidden";
      });
      await assert.rejects(() => dispatchVendor(tenant(USERS.tenant2), ticketId, { vendorName: "陳水電", vendorPhone: "0912000111", contactWindow: "週三 14:00-17:00" }, ORIGIN), (error: unknown) => {
        return error instanceof FlowError && error.key === "errors.forbidden";
      });
      await assert.rejects(() => dispatchVendor(coast, ticketId, { vendorName: "陳水電", vendorPhone: "0912000111", contactWindow: "週三 14:00-17:00" }, ORIGIN), (error: unknown) => {
        return error instanceof FlowError && error.key === "errors.notFound";
      });

      const ownerView = await tx(USERS.owner, (client) =>
        client.query(`SELECT id FROM maintenance_tickets WHERE id = $1`, [ticketId]),
      );
      assert.equal(ownerView.rowCount, 0);

      const issued = await dispatchVendor(maintenance, ticketId, {
        vendorName: "陳水電",
        vendorPhone: "0912000111",
        vendorTrade: "水電",
        contactWindow: "週三 14:00-17:00",
      }, ORIGIN);
      const token = tokenOf(issued.url);
      assert.equal(token.length >= 43, true);
      const page = await loadVendorJob(token);
      assert.equal(page?.title, title);
      assert.equal(page?.window, "週三 14:00-17:00");
      assert.match(page?.address ?? "", /\S/);
      assert.equal(page?.reported, false);

      const own = await tx(USERS.admin, (client) =>
        client.query(`SELECT id FROM repair_vendor_jobs WHERE ticket_id = $1`, [ticketId]),
      );
      assert.equal(own.rowCount, 1);
      const otherFirm = await tx(USERS.coastAdmin, (client) =>
        client.query(`SELECT id FROM repair_vendor_jobs WHERE ticket_id = $1`, [ticketId]),
      );
      assert.equal(otherFirm.rowCount, 0);
      await assert.rejects(
        () => tx(USERS.admin, (client) => client.query(`SELECT token FROM repair_vendor_secrets`)),
        (error: unknown) => error instanceof FlowError && error.key === "errors.forbidden",
      );
      await assert.rejects(
        () => tx(USERS.admin, (client) => client.query(`SELECT * FROM app.open_vendor_job($1)`, [hashVendorToken(token)])),
        (error: unknown) => error instanceof FlowError && error.key === "errors.forbidden",
      );
      const privileges = await withClient((client) =>
        client.query<{ name: string; anon_exec: boolean; auth_exec: boolean; public_exec: boolean }>(
          `SELECT n.nspname || '.' || p.proname AS name,
                  has_function_privilege('anon', p.oid, 'EXECUTE') AS anon_exec,
                  has_function_privilege('authenticated', p.oid, 'EXECUTE') AS auth_exec,
                  EXISTS (
                    SELECT 1 FROM aclexplode(p.proacl) acl
                     WHERE acl.grantee = 0 AND acl.privilege_type = 'EXECUTE'
                  ) AS public_exec
             FROM pg_proc p
             JOIN pg_namespace n ON n.oid = p.pronamespace
            WHERE (n.nspname, p.proname) IN (
              ('public', 'fn_vendor_job_photo'),
              ('app', 'drop_vendor_job_secret'),
              ('app', 'vendor_dispatch_enabled'),
              ('app', 'open_vendor_job')
            )`,
        ),
      );
      const byName = new Map(privileges.rows.map((row) => [row.name, row]));
      for (const name of [
        "public.fn_vendor_job_photo",
        "app.drop_vendor_job_secret",
        "app.vendor_dispatch_enabled",
        "app.open_vendor_job",
      ]) {
        const row = byName.get(name);
        assert.equal(row?.anon_exec, false, name);
        assert.equal(row?.auth_exec, false, name);
        assert.equal(row?.public_exec, false, name);
      }
      await assert.rejects(
        () =>
          tx(USERS.maintenance, (client) =>
            client.query(
              `INSERT INTO repair_vendor_jobs (
                 org_id, ticket_id, vendor_name, vendor_phone, contact_window, token_hash, expires_at
               ) VALUES ($1,$2,'甲','+886912000111','時段',$3, now() + interval '1 day')`,
              [ORG, ticketId, "a".repeat(64)],
            ),
          ),
        (error: unknown) => error instanceof FlowError && error.key === "errors.forbidden",
      );

      const fileId = randomUUID();
      const path = ticketPhotoPath(ORG, ticketId, fileId, "image/jpeg");
      const internalId = randomUUID();
      const internalPath = ticketPhotoPath(ORG, ticketId, internalId, "image/jpeg");
      const otherTicket = await createTicket(tenant(USERS.tenant2), {
        leaseId: wang.id,
        category: "other",
        title: `${title}-other`,
        description: "別的",
      });
      const otherFile = randomUUID();
      const otherPath = ticketPhotoPath(ORG, otherTicket, otherFile, "image/jpeg");
      await svc(null, async (client) => {
        await client.query(
          `INSERT INTO files (id, org_id, storage_bucket, storage_path, file_name, mime_type, size_bytes)
           VALUES ($1,$2,$3,$4,$5,'image/jpeg',4), ($6,$2,$3,$7,$8,'image/jpeg',4), ($9,$2,$3,$10,$11,'image/jpeg',4)`,
          [fileId, ORG, PHOTO_BUCKET, path, `${title}.jpg`, internalId, internalPath, `${title}-internal.jpg`, otherFile, otherPath, `${title}-other.jpg`],
        );
        await client.query(
          `INSERT INTO ticket_attachments (org_id, ticket_id, file_id, is_internal)
           VALUES ($1,$2,$3,false), ($1,$2,$4,true), ($1,$5,$6,false)`,
          [ORG, ticketId, fileId, internalId, otherTicket, otherFile],
        );
      });
      const visible = await findVendorPhoto(token, (
        await svc(null, (client) => client.query<{ id: string }>(`SELECT id::text FROM ticket_attachments WHERE file_id = $1`, [fileId]))
      ).rows[0].id);
      assert.equal(visible?.path, path);
      const internalAttachment = (
        await svc(null, (client) => client.query<{ id: string }>(`SELECT id::text FROM ticket_attachments WHERE file_id = $1`, [internalId]))
      ).rows[0].id;
      const otherAttachment = (
        await svc(null, (client) => client.query<{ id: string }>(`SELECT id::text FROM ticket_attachments WHERE file_id = $1`, [otherFile]))
      ).rows[0].id;
      assert.equal(await findVendorPhoto(token, internalAttachment), null);
      assert.equal(await findVendorPhoto(token, otherAttachment), null);
      assert.equal(await findVendorPhoto("not-a-token", visible?.path ? (await svc(null, (client) => client.query<{ id: string }>(`SELECT id::text FROM ticket_attachments WHERE file_id = $1`, [fileId]))).rows[0].id : ""), null);
      assert.equal(await loadVendorJob("not-a-token"), null);

      await svc(null, (client) =>
        client.query(`UPDATE repair_vendor_jobs SET expires_at = now() - interval '1 minute' WHERE id = $1`, [issued.jobId]),
      );
      const expired = await svc(null, (client) =>
        client.query(`SELECT job_id FROM app.open_vendor_job($1)`, [hashVendorToken(token)]),
      );
      assert.equal(expired.rowCount, 0);
      const secretAfterExpiry = await svc(null, (client) =>
        client.query(`SELECT job_id FROM repair_vendor_secrets WHERE job_id = $1`, [issued.jobId]),
      );
      assert.equal(secretAfterExpiry.rowCount, 0);
      await assert.rejects(() => submitVendorReport(token, { done: true, cost: "2400" }), (error: unknown) => {
        return error instanceof FlowError && error.key === "errors.notFound";
      });
      assert.equal(await findVendorPhoto(token, (await svc(null, (client) => client.query<{ id: string }>(`SELECT id::text FROM ticket_attachments WHERE file_id = $1`, [fileId]))).rows[0].id), null);

      const again = await dispatchVendor(admin, ticketId, {
        vendorName: "陳水電",
        vendorPhone: "0912-000-111",
        vendorTrade: "水電",
        contactWindow: "週三 14:00-17:00",
      }, ORIGIN);
      const liveToken = tokenOf(again.url);
      await submitVendorReport(liveToken, { done: true, cost: "2400" });
      await submitVendorReport(liveToken, { done: true, cost: "9999" });
      const reported = await loadVendorJob(liveToken);
      assert.equal(reported?.reported, true);
      const costRow = await svc(null, (client) =>
        client.query<{ cost: string }>(`SELECT reported_cost_minor::text AS cost FROM repair_vendor_jobs WHERE id = $1`, [again.jobId]),
      );
      assert.equal(costRow.rows[0].cost, "240000");
      await assert.rejects(() => confirmVendorCost(maintenance, ticketId, again.jobId), (error: unknown) => {
        return error instanceof FlowError && error.key === "errors.forbidden";
      });
      await assert.rejects(() => confirmVendorCost(coast, ticketId, again.jobId), (error: unknown) => {
        return error instanceof FlowError && error.key === "errors.notFound";
      });

      const place = await tx(USERS.admin, (client) =>
        client.query<{ property_id: string; unit_id: string | null }>(
          `SELECT property_id::text, unit_id::text FROM maintenance_tickets WHERE id = $1`,
          [ticketId],
        ),
      );
      await confirmVendorCost(admin, ticketId, again.jobId);
      const expense = await tx(USERS.admin, (client) =>
        client.query<{
          status: string;
          bill_to: string;
          amount: string;
          ticket_id: string;
          property_id: string;
          unit_id: string | null;
          incurred_on: string;
          ledger: string | null;
        }>(
          `SELECT e.status::text, e.bill_to::text, e.amount_minor::text AS amount, e.ticket_id::text,
                  e.property_id::text, e.unit_id::text, e.incurred_on::text, e.ledger_transaction_id::text AS ledger
             FROM expenses e
             JOIN maintenance_tickets t ON t.expense_id = e.id
            WHERE t.id = $1`,
          [ticketId],
        ),
      );
      const row = expense.rows[0];
      assert.equal(row.status, "posted");
      assert.equal(row.bill_to, "owner");
      const closedTicket = await tx(USERS.admin, (client) =>
        client.query<{ status: string }>(`SELECT status::text FROM maintenance_tickets WHERE id = $1`, [ticketId]),
      );
      assert.equal(closedTicket.rows[0]?.status, "closed");
      assert.equal(row.amount, "240000");
      assert.equal(row.ticket_id, ticketId);
      assert.equal(row.property_id, place.rows[0].property_id);
      assert.equal(row.unit_id, place.rows[0].unit_id);
      assert.ok(row.ledger);
      const day = row.incurred_on.slice(0, 10);
      const report = await loadIncomeExpense(admin, { start: day, end: day, propertyId: row.property_id });
      const property = report.find((item) => item.property_id === row.property_id);
      assert.ok(property);
      assert.ok(Number(property.expense_minor) >= 240000);

      const events = await svc(null, (client) =>
        client.query<{ event_type: string }>(
          `SELECT event_type FROM audit_log
            WHERE org_id = $1 AND new_row->>'ticketId' = $2
            ORDER BY id`,
          [ORG, ticketId],
        ),
      );
      const names = events.rows.map((item) => item.event_type);
      assert.ok(names.includes("repair_dispatch"));
      assert.ok(names.includes("repair_vendor_report"));
      assert.ok(names.includes("repair_cost_confirm"));
      const reportAudit = await svc(null, (client) =>
        client.query<{ body: string }>(
          `SELECT new_row::text AS body FROM audit_log
            WHERE org_id = $1 AND event_type = 'repair_vendor_report' AND new_row->>'ticketId' = $2`,
          [ORG, ticketId],
        ),
      );
      assert.equal(reportAudit.rows[0].body.includes("+886"), false);
      assert.equal(reportAudit.rows[0].body.includes(liveToken), false);

      await assert.rejects(() => dispatchVendor(admin, ticketId, { vendorName: "陳水電", vendorPhone: "0912000111", contactWindow: "週四" }, ORIGIN), (error: unknown) => {
        return error instanceof FlowError && error.key === "errors.expenseState";
      });

      const third = await createTicket(tenant(USERS.tenant2), {
        leaseId: wang.id,
        category: "other",
        title: `${title}-revoke`,
        description: "停用",
      });
      const revoked = await dispatchVendor(admin, third, {
        vendorName: "陳水電",
        vendorPhone: "0912000111",
        vendorTrade: "水電",
        contactWindow: "週五 9:00-12:00",
      }, ORIGIN);
      const revokedToken = tokenOf(revoked.url);
      await revokeVendorJob(admin, third, revoked.jobId);
      assert.equal(await loadVendorJob(revokedToken), null);
      const openAfterRevoke = await svc(null, (client) =>
        client.query(`SELECT job_id FROM app.open_vendor_job($1)`, [hashVendorToken(revokedToken)]),
      );
      assert.equal(openAfterRevoke.rowCount, 0);
      const secretAfterRevoke = await svc(null, (client) =>
        client.query(`SELECT job_id FROM repair_vendor_secrets WHERE job_id = $1`, [revoked.jobId]),
      );
      assert.equal(secretAfterRevoke.rowCount, 0);
      await assert.rejects(() => submitVendorReport(revokedToken, { done: true, cost: "100" }), (error: unknown) => {
        return error instanceof FlowError && error.key === "errors.notFound";
      });
      const revokeAudit = await svc(null, (client) =>
        client.query(`SELECT id FROM audit_log WHERE event_type = 'repair_dispatch_revoke' AND new_row->>'jobId' = $1`, [revoked.jobId]),
      );
      assert.equal(revokeAudit.rowCount, 1);
    } finally {
      await cleanup(title);
    }
  });

  test("a tenant can cancel only while the repair is still new", async () => {
    const title = `取消報修${Date.now()}`;
    const wang = await leaseFor(USERS.tenant2);
    assert.ok(wang);
    const person = tenant(USERS.tenant2);
    try {
      const openId = await createTicket(person, {
        leaseId: wang.id,
        category: "other",
        title,
        description: "還沒派人",
      });
      await cancelTenantRepair(person, openId);
      const cancelled = await tx(USERS.admin, (client) =>
        client.query<{ status: string }>(`SELECT status::text FROM maintenance_tickets WHERE id = $1`, [openId]),
      );
      assert.equal(cancelled.rows[0]?.status, "cancelled");
      await assert.rejects(() => cancelTenantRepair(person, openId), (error: unknown) => {
        return error instanceof FlowError && error.key === "errors.repairCancelLocked";
      });

      const assigned = await createTicket(person, {
        leaseId: wang.id,
        category: "other",
        title: `${title}-assigned`,
        description: "已指派",
      });
      await tx(USERS.admin, (client) =>
        client.query(`UPDATE maintenance_tickets SET status = 'assigned' WHERE id = $1`, [assigned]),
      );
      await assert.rejects(() => cancelTenantRepair(person, assigned), (error: unknown) => {
        return error instanceof FlowError && error.key === "errors.repairCancelLocked";
      });
      await assert.rejects(() => cancelTenantRepair(staff(USERS.admin, "admin"), openId), (error: unknown) => {
        return error instanceof FlowError && error.key === "errors.forbidden";
      });
    } finally {
      await cleanup(title);
    }
  });

  test("the flag stays off for a pro firm and a beta firm can turn it off", async () => {
    const tw = await svc(null, (client) => client.query<{ id: string }>(`SELECT id::text FROM jurisdictions WHERE code = 'TW'`));
    const jurisdictionId = tw.rows[0]?.id;
    assert.ok(jurisdictionId);
    await dropFirms();
    try {
      await svc(null, (client) =>
        client.query(
          `INSERT INTO organizations (
             id, name, country_code, jurisdiction_id, default_currency, timezone, plan_tier, environment, created_by
           ) VALUES ($1, '進階公司', 'TW', $2, 'TWD', 'Asia/Taipei', 'pro', 'live', $3)`,
          [PRO_ORG, jurisdictionId, USERS.admin],
        ),
      );
      await svc(null, (client) =>
        client.query(
          `INSERT INTO organizations (
             id, name, country_code, jurisdiction_id, default_currency, timezone, plan_tier, environment, live_org_id, created_by
           ) VALUES ($1, '練習公司', 'TW', $2, 'TWD', 'Asia/Taipei', 'free', 'sandbox', $3, $4)`,
          [SANDBOX_ORG, jurisdictionId, ORG, USERS.admin],
        ),
      );
      const flags = await svc(null, (client) =>
        client.query<{ id: string; ok: boolean }>(
          `SELECT id::text, app.vendor_dispatch_enabled(id) AS ok
             FROM organizations WHERE id = ANY($1::uuid[])`,
          [[PRO_ORG, SANDBOX_ORG, ORG]],
        ),
      );
      const byId = new Map(flags.rows.map((row) => [row.id, row.ok]));
      assert.equal(byId.get(PRO_ORG), false);
      assert.equal(byId.get(SANDBOX_ORG), true);
      assert.equal(byId.get(ORG), true);
      await assert.rejects(
        () => dispatchVendor(staff(USERS.admin, "admin", PRO_ORG), randomUUID(), { vendorName: "陳水電", vendorPhone: "0912000111", contactWindow: "週三" }, ORIGIN),
        (error: unknown) => error instanceof FlowError && error.key === "errors.forbidden",
      );
      await svc(null, (client) =>
        client.query(`UPDATE organizations SET feature_flags = feature_flags || '{"vendor_dispatch": false}'::jsonb WHERE id = $1`, [ORG]),
      );
      const off = await svc(null, (client) => client.query<{ ok: boolean }>(`SELECT app.vendor_dispatch_enabled($1::uuid) AS ok`, [ORG]));
      assert.equal(off.rows[0].ok, false);
      await assert.rejects(
        () => dispatchVendor(staff(USERS.admin, "admin"), randomUUID(), { vendorName: "陳水電", vendorPhone: "0912000111", contactWindow: "週三" }, ORIGIN),
        (error: unknown) => error instanceof FlowError && error.key === "errors.forbidden",
      );
    } finally {
      await svc(null, (client) =>
        client.query(`UPDATE organizations SET feature_flags = feature_flags - 'vendor_dispatch' WHERE id = $1`, [ORG]),
      );
      await dropFirms();
    }
  });

  test("last cooperation is the latest repair month for that vendor", async () => {
    const title = `上次合作${Date.now()}`;
    const wang = await leaseFor(USERS.tenant2);
    assert.ok(wang);
    const admin = staff(USERS.admin, "admin");
    const person = tenant(USERS.tenant2);
    let first = "";
    let second = "";
    let vendorId = "";
    try {
      first = await createTicket(person, { leaseId: wang.id, category: "other", title, description: "第一次" });
      second = await createTicket(person, { leaseId: wang.id, category: "other", title: `${title}-2`, description: "第二次" });
      vendorId = await addVendor(admin, first, { name: title, phone: "0912000111", trade: "water" });
      await dispatchVendor(admin, first, { vendorId, vendorName: "", vendorPhone: "", contactWindow: "週三" }, ORIGIN);
      await tx(USERS.admin, (client) =>
        client.query(`UPDATE maintenance_tickets SET completed_on = '2026-08-20', scheduled_on = '2026-08-01' WHERE id = $1`, [first]),
      );
      const loaded = await loadVendorDispatch(admin, second, ORIGIN);
      const choice = loaded?.vendors.find((vendor) => vendor.id === vendorId);
      assert.equal(choice?.lastOn, "2026-08-20");
      assert.deepEqual(lastCooperationParts(choice?.lastOn), { year: "2026", month: "8" });
      const column = await svc(null, (client) =>
        client.query(
          `SELECT 1 FROM information_schema.columns
            WHERE table_name IN ('contacts', 'maintenance_tickets', 'repair_vendor_jobs')
              AND column_name = 'last_cooperation'`,
        ),
      );
      assert.equal(column.rowCount, 0);
    } finally {
      await cleanup(title);
      if (vendorId) {
        await svc(null, (client) => client.query(`DELETE FROM contacts WHERE id = $1 AND org_id = $2`, [vendorId, ORG]));
      }
    }
  });
});
