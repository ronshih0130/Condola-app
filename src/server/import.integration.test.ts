import assert from "node:assert/strict";
import test from "node:test";
import { query, tx, withClient } from "./db";
import { FlowError } from "./errors";
import { commitImportBatch, dryRunImport } from "./import-batch";
import { ORG2_ID, ORG_ID, USERS } from "./ids";
import type { ImportRequestRow } from "./owner-import";
import { ensureSandbox } from "./sandbox";
import type { Session } from "./types";

function staff(overrides: Partial<Session> & Pick<Session, "userId" | "role">): Session {
  return {
    userId: overrides.userId,
    sessionId: "import-integration",
    email: "yating.lin@songxin.demo",
    name: "Admin",
    kind: "staff",
    role: overrides.role,
    orgId: overrides.orgId ?? ORG_ID,
    liveOrgId: overrides.liveOrgId ?? ORG_ID,
    environment: overrides.environment ?? "live",
    locale: "zh-TW",
    calendar: "gregorian",
    leaseId: null,
  };
}

const admin = staff({ userId: USERS.admin, role: "admin" });
const manager = staff({ userId: USERS.manager, role: "manager", email: "zhiming.huang@songxin.demo", name: "Manager" });
const accountant = staff({ userId: USERS.accountant, role: "accountant", email: "meiling.zhou@songxin.demo", name: "Accountant" });

function row(overrides: Partial<ImportRequestRow> = {}): ImportRequestRow {
  return {
    line: 2,
    propertyName: "",
    address: "",
    ownerName: "",
    ownerEmail: "",
    rentalMode: "整層",
    unitLabel: "5F",
    roomLabel: "",
    roomType: "",
    area: "12",
    rent: "10000",
    tenantName: "匯入租客",
    tenantPhone: "0912000222",
    tenantEmail: "",
    tenantId: "",
    startDate: "2026-11-01",
    endDate: "2027-10-31",
    deposit: "20000",
    dueDay: "5",
    electricity: "",
    rate: "",
    billKwh: "",
    billAmount: "",
    opening: "",
    depositReason: "",
    rateReason: "",
    notes: "",
    ...overrides,
  };
}

async function cleanup(names: string[], emails: string[], fileNames: string[]) {
  await withClient(async (client) => {
    await client.query(`ALTER TABLE lease_signature_events DISABLE TRIGGER trg_lease_signature_events_append_only`);
    try {
      if (names.length) {
        await client.query(
          `DELETE FROM rule_check_results
            WHERE entity_table = 'leases'
              AND entity_id IN (SELECT id FROM leases WHERE property_id IN (SELECT id FROM properties WHERE name = ANY($1::text[])))`,
          [names],
        );
        await client.query(
          `DELETE FROM leases WHERE property_id IN (SELECT id FROM properties WHERE name = ANY($1::text[]))`,
          [names],
        );
        await client.query(
          `DELETE FROM listing_terms
            WHERE unit_id IN (SELECT id FROM units WHERE property_id IN (SELECT id FROM properties WHERE name = ANY($1::text[])))
               OR room_id IN (
                 SELECT r.id FROM rooms r
                   JOIN units u ON u.id = r.unit_id
                  WHERE u.property_id IN (SELECT id FROM properties WHERE name = ANY($1::text[]))
               )`,
          [names],
        );
        await client.query(`DELETE FROM properties WHERE name = ANY($1::text[])`, [names]);
      }
      if (emails.length) {
        await client.query(`DELETE FROM contacts WHERE lower(email::text) = ANY($1::text[])`, [emails.map((email) => email.toLowerCase())]);
      }
      if (fileNames.length) {
        await client.query(`DELETE FROM import_jobs WHERE column_map->>'fileName' = ANY($1::text[])`, [fileNames]);
      }
    } finally {
      await client.query(`ALTER TABLE lease_signature_events ENABLE TRIGGER trg_lease_signature_events_append_only`);
    }
  });
}

test("commit saves an active signed lease, rejects an unexplained deposit, and reuses on the next run", async () => {
  const stamp = `${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;
  const name = `匯入測試${stamp}`;
  const address = `台北市大安區匯入路${stamp}號`;
  const ownerEmail = `owner.${stamp}@example.com`;
  const tenantEmail = `tenant.${stamp}@example.com`;
  const phone = `09${String(20000000 + (Date.now() % 70000000)).slice(-8)}`;
  const tenantId = `A${stamp.slice(0, 9).toUpperCase()}`;
  const fileName = `good-${stamp}.csv`;
  const badFile = `deposit-${stamp}.csv`;
  try {
    const blocked = await commitImportBatch(admin, {
      fileName: badFile,
      rows: [row({ propertyName: name, address, ownerName: "測試屋主", ownerEmail, tenantEmail, tenantPhone: phone, tenantId, deposit: "30000" })],
    });
    assert.equal(blocked.created.leases, 0);
    assert.ok(blocked.errors.some((issue) => issue.key === "im_e_dep"));
    const blockedLease = await query<{ n: string }>(`SELECT count(*)::text AS n FROM properties WHERE name = $1`, [name]);
    assert.equal(blockedLease.rows[0].n, "0");

    const first = await commitImportBatch(admin, {
      fileName,
      rows: [
        row({
          propertyName: name,
          address,
          ownerName: "測試屋主",
          ownerEmail,
          tenantEmail,
          tenantPhone: phone,
          tenantId,
          deposit: "30000",
          depositReason: "屋主同意三個月",
        }),
      ],
    });
    assert.equal(first.dryRun, false);
    assert.equal(first.created.properties, 1);
    assert.equal(first.created.units, 1);
    assert.equal(first.created.tenants, 1);
    assert.equal(first.created.leases, 1);
    assert.equal(first.errors.length, 0);

    const saved = await query<{
      status: string;
      esign: string;
      reason: string | null;
      overridden_by: string | null;
      hash: string | null;
      user_id: string | null;
      invoices: string;
    }>(
      `SELECT l.status::text, l.esign_status::text AS esign, l.deposit_override_reason AS reason,
              l.deposit_overridden_by::text AS overridden_by, c.id_number_hash AS hash, c.user_id::text,
              (SELECT count(*) FROM invoices i WHERE i.lease_id = l.id)::text AS invoices
         FROM leases l
         JOIN properties p ON p.id = l.property_id
         JOIN lease_parties lp ON lp.lease_id = l.id AND lp.role = 'primary'
         JOIN contacts c ON c.id = lp.contact_id
        WHERE p.name = $1`,
      [name],
    );
    assert.equal(saved.rows.length, 1);
    assert.equal(saved.rows[0].status, "active");
    assert.equal(saved.rows[0].esign, "fully_signed");
    assert.equal(saved.rows[0].reason, "屋主同意三個月");
    assert.equal(saved.rows[0].overridden_by, USERS.admin);
    assert.equal(saved.rows[0].user_id, null);
    assert.equal(saved.rows[0].invoices, "0");
    assert.equal(saved.rows[0].hash?.length, 64);
    assert.notEqual(saved.rows[0].hash, tenantId);

    const again = await commitImportBatch(admin, {
      fileName,
      rows: [
        row({
          propertyName: name,
          address,
          ownerName: "測試屋主",
          ownerEmail,
          tenantEmail,
          tenantPhone: phone,
          tenantId,
          deposit: "30000",
          depositReason: "屋主同意三個月",
        }),
      ],
    });
    assert.equal(again.created.leases, 0);
    assert.equal(again.created.units, 0);
    assert.equal(again.reused.units, 1);
    assert.equal(again.reused.tenants, 1);
    assert.equal(again.reused.leases, 1);
    const leaseCount = await query<{ n: string }>(
      `SELECT count(*)::text AS n FROM leases l JOIN properties p ON p.id = l.property_id WHERE p.name = $1`,
      [name],
    );
    assert.equal(leaseCount.rows[0].n, "1");
    const unitCount = await query<{ n: string }>(
      `SELECT count(*)::text AS n FROM units u JOIN properties p ON p.id = u.property_id WHERE p.name = $1`,
      [name],
    );
    assert.equal(unitCount.rows[0].n, "1");
  } finally {
    await cleanup([name], [ownerEmail, tenantEmail], [fileName, badFile]);
  }
});

test("one import batch writes one import_batch audit row", async () => {
  const stamp = `${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}b`;
  const name = `匯入批次${stamp}`;
  const address = `台北市中山區批次路${stamp}號`;
  const ownerEmail = `batch.${stamp}@example.com`;
  const fileName = `batch-${stamp}.csv`;
  const phoneA = `09${String(30000000 + (Date.now() % 50000000)).slice(-8)}`;
  const phoneB = `09${String(40000000 + (Date.now() % 50000000)).slice(-8)}`;
  try {
    const empty = await commitImportBatch(admin, { fileName: `empty-${stamp}.csv`, rows: [] });
    assert.equal(empty.created.leases, 0);
    const emptyAudit = await query<{ n: string }>(
      `SELECT count(*)::text AS n FROM audit_log WHERE event_type = 'import_batch' AND new_row->>'fileName' = $1`,
      [`empty-${stamp}.csv`],
    );
    assert.equal(emptyAudit.rows[0].n, "0");

    const result = await commitImportBatch(admin, {
      fileName,
      rows: [
        row({ line: 2, propertyName: name, address, ownerName: "批次屋主", ownerEmail, unitLabel: "1F", tenantPhone: phoneA, tenantEmail: `a.${stamp}@example.com`, tenantId: `B${stamp.slice(0, 8)}` }),
        row({ line: 3, propertyName: name, address, ownerName: "批次屋主", ownerEmail, unitLabel: "2F", tenantPhone: phoneB, tenantEmail: `b.${stamp}@example.com`, tenantId: `C${stamp.slice(0, 8)}` }),
      ],
    });
    assert.equal(result.created.leases, 2);
    assert.equal(result.created.properties, 1);
    const audits = await query<{ n: string }>(
      `SELECT count(*)::text AS n FROM audit_log WHERE event_type = 'import_batch' AND new_row->>'fileName' = $1`,
      [fileName],
    );
    assert.equal(audits.rows[0].n, "1");
    const jobs = await query<{ n: string }>(
      `SELECT count(*)::text AS n FROM import_jobs WHERE entity = 'bulk' AND column_map->>'fileName' = $1`,
      [fileName],
    );
    assert.equal(jobs.rows[0].n, "1");
  } finally {
    await cleanup([name], [ownerEmail, `a.${stamp}@example.com`, `b.${stamp}@example.com`], [fileName]);
  }
});

test("another organization cannot read or update imported units", async () => {
  const stamp = `${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}x`;
  const name = `匯入隔離${stamp}`;
  const address = `台北市松山區隔離路${stamp}號`;
  const ownerEmail = `iso.${stamp}@example.com`;
  const fileName = `iso-${stamp}.csv`;
  try {
    const result = await commitImportBatch(admin, {
      fileName,
      rows: [row({ propertyName: name, address, ownerName: "隔離屋主", ownerEmail, tenantEmail: `t.${stamp}@example.com`, tenantPhone: `09${String(51000000 + (Date.now() % 40000000)).slice(-8)}` })],
    });
    assert.equal(result.created.units, 1);
    const stored = await query<{ unit_id: string }>(
      `SELECT u.id::text AS unit_id FROM units u JOIN properties p ON p.id = u.property_id WHERE p.name = $1`,
      [name],
    );
    const unitId = stored.rows[0].unit_id;
    const denied = await tx(
      USERS.coastAdmin,
      async (client) => {
        const seen = await client.query(`SELECT id FROM properties WHERE name = $1`, [name]);
        const updated = await client.query(`UPDATE units SET notes = 'denied' WHERE id = $1`, [unitId]);
        return { seen: seen.rowCount, updated: updated.rowCount };
      },
      { orgId: ORG2_ID, environment: "live" },
    );
    assert.equal(denied.seen, 0);
    assert.equal(denied.updated, 0);
    const notes = await query<{ notes: string | null }>(`SELECT notes FROM units WHERE id = $1`, [unitId]);
    assert.equal(notes.rows[0].notes, null);
  } finally {
    await cleanup([name], [ownerEmail, `t.${stamp}@example.com`], [fileName]);
  }
});

test("sandbox import stays in the sandbox organization", async () => {
  const stamp = `${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}s`;
  const name = `匯入沙盒${stamp}`;
  const address = `台北市內湖區沙盒路${stamp}號`;
  const ownerEmail = `sand.${stamp}@example.com`;
  const fileName = `sand-${stamp}.csv`;
  const sandboxId = await ensureSandbox(admin);
  const sandbox = staff({ userId: USERS.admin, role: "admin", orgId: sandboxId, environment: "sandbox" });
  try {
    const result = await commitImportBatch(sandbox, {
      fileName,
      rows: [row({ propertyName: name, address, ownerName: "沙盒屋主", ownerEmail, tenantEmail: `st.${stamp}@example.com`, tenantPhone: `09${String(61000000 + (Date.now() % 30000000)).slice(-8)}` })],
    });
    assert.equal(result.created.leases, 1);
    const live = await tx(
      USERS.admin,
      async (client) => (await client.query(`SELECT id FROM properties WHERE name = $1`, [name])).rowCount,
      { orgId: ORG_ID, environment: "live" },
    );
    const pinned = await tx(
      USERS.admin,
      async (client) => (await client.query(`SELECT id FROM properties WHERE name = $1`, [name])).rowCount,
      { orgId: sandboxId, environment: "sandbox" },
    );
    assert.equal(live, 0);
    assert.equal(pinned, 1);
    const audit = await query<{ org_id: string }>(
      `SELECT org_id::text FROM audit_log WHERE event_type = 'import_batch' AND new_row->>'fileName' = $1`,
      [fileName],
    );
    assert.equal(audit.rows.length, 1);
    assert.equal(audit.rows[0].org_id, sandboxId);
  } finally {
    await cleanup([name], [ownerEmail, `st.${stamp}@example.com`], [fileName]);
  }
});

test("an accountant cannot import and a manager can", async () => {
  const stamp = `${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}m`;
  const name = `匯入經理${stamp}`;
  const fileName = `mgr-${stamp}.csv`;
  const ownerEmail = `mgr.${stamp}@example.com`;
  await assert.rejects(
    () =>
      commitImportBatch(accountant, {
        fileName,
        rows: [row({ propertyName: name, address: `台北市萬華區經理路${stamp}號`, ownerName: "經理屋主", ownerEmail })],
      }),
    (error: unknown) => error instanceof FlowError && error.key === "errors.forbidden",
  );
  try {
    const dry = await dryRunImport(manager, {
      fileName,
      rows: [row({ propertyName: name, address: `台北市萬華區經理路${stamp}號`, ownerName: "經理屋主", ownerEmail, tenantEmail: `mt.${stamp}@example.com` })],
    });
    assert.equal(dry.dryRun, true);
    assert.equal(dry.created.leases, 1);
    const none = await query<{ n: string }>(`SELECT count(*)::text AS n FROM properties WHERE name = $1`, [name]);
    assert.equal(none.rows[0].n, "0");
    const committed = await commitImportBatch(manager, {
      fileName,
      rows: [row({ propertyName: name, address: `台北市萬華區經理路${stamp}號`, ownerName: "經理屋主", ownerEmail, tenantEmail: `mt.${stamp}@example.com`, tenantPhone: `09${String(71000000 + (Date.now() % 20000000)).slice(-8)}` })],
    });
    assert.equal(committed.created.leases, 1);
  } finally {
    await cleanup([name], [ownerEmail, `mt.${stamp}@example.com`], [fileName]);
  }
});
