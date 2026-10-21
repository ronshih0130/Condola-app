import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { crc32 } from "node:zlib";
import { readSpreadsheet } from "../lib/spreadsheet";
import { query, tx, withClient } from "./db";
import { FlowError } from "./errors";
import { BILLABLE_ACTIVE_LEASE } from "./billing";
import { createProperty, uploadSignedLeasePdf } from "./domain";
import { commitImportBatch, dryRunImport } from "./import-batch";
import { addressKey, matchColumns, tableToRows, templateHeaders } from "./owner-import";
import { countActiveUnits } from "./sandbox";
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
      const emailsLower = emails.map((email) => email.toLowerCase());
      if (names.length || emailsLower.length) {
        await client.query(
          `DELETE FROM management_agreements
            WHERE ($1::text[] <> '{}'::text[] AND property_id IN (SELECT id FROM properties WHERE name = ANY($1::text[])))
               OR ($2::text[] <> '{}'::text[] AND owner_contact_id IN (
                    SELECT id FROM contacts WHERE lower(email::text) = ANY($2::text[])
                  ))`,
          [names, emailsLower],
        );
      }
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
        await client.query(`DELETE FROM contacts WHERE lower(email::text) = ANY($1::text[])`, [emailsLower]);
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
  const fileName = `good-${stamp}.csv`;
  const badFile = `deposit-${stamp}.csv`;
  try {
    const blocked = await commitImportBatch(admin, {
      fileName: badFile,
      rows: [row({ propertyName: name, address, ownerName: "測試屋主", ownerEmail, tenantEmail, tenantPhone: phone, deposit: "30000" })],
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
    assert.equal(saved.rows[0].esign, "imported");
    assert.equal(saved.rows[0].reason, "屋主同意三個月");
    assert.equal(saved.rows[0].overridden_by, USERS.admin);
    assert.equal(saved.rows[0].user_id, null);
    assert.equal(saved.rows[0].invoices, "0");
    assert.equal(saved.rows[0].hash, null);
    const signed = await query<{ signed_at: string | null; sigs: string; consent: string }>(
      `SELECT l.signed_at::text, l.document_sha256,
              (SELECT count(*) FROM lease_signatures s WHERE s.lease_id = l.id)::text AS sigs,
              (SELECT count(*) FROM lease_signatures s WHERE s.lease_id = l.id AND s.consent_text_key = 'lease.consent')::text AS consent
         FROM leases l
         JOIN properties p ON p.id = l.property_id
        WHERE p.name = $1`,
      [name],
    );
    assert.equal(signed.rows[0].signed_at, null);
    assert.equal(signed.rows[0].sigs, "0");
    assert.equal(signed.rows[0].consent, "0");
    const ids = await query<{ lease_id: string; unit_id: string }>(
      `SELECT l.id::text AS lease_id, l.target_unit_id::text AS unit_id
         FROM leases l JOIN properties p ON p.id = l.property_id WHERE p.name = $1`,
      [name],
    );
    await uploadSignedLeasePdf(admin, ids.rows[0].lease_id, {
      bytes: Uint8Array.from(Buffer.from("%PDF-1.1\n%%EOF\n")),
      fileName: "paper.pdf",
    });
    const paper = await query<{ esign: string; signed_at: string | null; pdfs: string; signed_sigs: string }>(
      `SELECT l.esign_status::text AS esign, l.signed_at::text,
              (SELECT count(*) FROM lease_signed_pdfs pdf WHERE pdf.lease_id = l.id)::text AS pdfs,
              (SELECT count(*) FROM lease_signatures s WHERE s.lease_id = l.id AND s.signed_at IS NOT NULL)::text AS signed_sigs
         FROM leases l WHERE l.id = $1`,
      [ids.rows[0].lease_id],
    );
    assert.equal(paper.rows[0].esign, "imported");
    assert.equal(paper.rows[0].signed_at, null);
    assert.equal(paper.rows[0].pdfs, "1");
    assert.equal(paper.rows[0].signed_sigs, "0");
    const billable = await query<{ n: number }>(
      `SELECT count(DISTINCT coalesce(target_room_id::text, target_unit_id::text))::int AS n
         FROM leases
        WHERE org_id = $1 AND ${BILLABLE_ACTIVE_LEASE} AND target_unit_id = $2::uuid`,
      [ORG_ID, ids.rows[0].unit_id],
    );
    assert.equal(billable.rows[0].n, 1);
    const signedOnly = await query<{ n: number }>(
      `SELECT count(*)::int AS n FROM leases
        WHERE org_id = $1 AND target_unit_id = $2 AND status = 'active' AND signed_at IS NOT NULL`,
      [ORG_ID, ids.rows[0].unit_id],
    );
    assert.equal(signedOnly.rows[0].n, 0);
    const activeUnits = await countActiveUnits(ORG_ID);
    assert.ok(activeUnits >= billable.rows[0].n);
    const auditBody = await query<{ body: string }>(
      `SELECT new_row::text AS body FROM audit_log WHERE event_type = 'import_batch' AND new_row->>'fileName' = $1`,
      [fileName],
    );
    assert.equal(auditBody.rows[0].body.includes("A123456789"), false);

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
    assert.equal(again.duplicateRows, 1);
    const leaseCount = await query<{ n: string }>(
      `SELECT count(*)::text AS n FROM leases l JOIN properties p ON p.id = l.property_id WHERE p.name = $1`,
      [name],
    );
    assert.equal(leaseCount.rows[0].n, "1");

    const changed = await commitImportBatch(admin, {
      fileName,
      rows: [
        row({
          propertyName: name,
          address,
          ownerName: "測試屋主",
          ownerEmail,
          tenantEmail,
          tenantPhone: phone,
          rent: "12000",
          deposit: "24000",
          depositReason: "屋主同意三個月",
        }),
      ],
    });
    assert.equal(changed.created.leases, 0);
    assert.equal(changed.reused.leases, 0);
    assert.ok(changed.errors.some((issue) => issue.key === "im_e_terms"));
    const stillOne = await query<{ n: string }>(
      `SELECT count(*)::text AS n FROM leases l JOIN properties p ON p.id = l.property_id WHERE p.name = $1`,
      [name],
    );
    assert.equal(stillOne.rows[0].n, "1");
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
        row({ line: 2, propertyName: name, address, ownerName: "批次屋主", ownerEmail, unitLabel: "1F", tenantPhone: phoneA, tenantEmail: `a.${stamp}@example.com` }),
        row({ line: 3, propertyName: name, address, ownerName: "批次屋主", ownerEmail, unitLabel: "2F", tenantPhone: phoneB, tenantEmail: `b.${stamp}@example.com` }),
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
      `SELECT count(*)::text AS n FROM import_jobs WHERE column_map->>'kind' = 'bulk' AND column_map->>'fileName' = $1`,
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

test("a phone that matches more than one tenant is an error and does not overwrite", async () => {
  const stamp = `${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}p`;
  const phone = `09${String(22000000 + (Date.now() % 70000000)).slice(-8)}`;
  const e164 = `+886${phone.slice(1)}`;
  const name = `匯入電話${stamp}`;
  const emailA = `dup.a.${stamp}@example.com`;
  const emailB = `dup.b.${stamp}@example.com`;
  const fileName = `dup-${stamp}.csv`;
  await query(
    `INSERT INTO contacts (org_id, is_tenant, display_name, email, phone_e164, locale)
     VALUES ($1, true, $2, $3, $5, 'zh-TW'), ($1, true, $4, $6, $5, 'zh-TW')`,
    [ORG_ID, `甲${stamp}`, emailA, `乙${stamp}`, e164, emailB],
  );
  try {
    const result = await commitImportBatch(admin, {
      fileName,
      rows: [row({ propertyName: name, address: `台北市信義區電話路${stamp}號`, ownerName: "電話屋主", ownerEmail: `own.${stamp}@example.com`, tenantName: "新名字", tenantPhone: phone, tenantEmail: `new.${stamp}@example.com` })],
    });
    assert.ok(result.errors.some((issue) => issue.key === "im_e_phone_dup"));
    assert.equal(result.created.tenants, 0);
    assert.equal(result.created.leases, 0);
    const names = await query<{ display_name: string }>(
      `SELECT display_name FROM contacts WHERE org_id = $1 AND phone_e164 = $2 ORDER BY display_name`,
      [ORG_ID, e164],
    );
    assert.deepEqual(names.rows.map((item) => item.display_name).sort(), [`乙${stamp}`, `甲${stamp}`].sort());
    const props = await query<{ n: string }>(`SELECT count(*)::text AS n FROM properties WHERE name = $1`, [name]);
    assert.equal(props.rows[0].n, "0");
  } finally {
    await cleanup([name], [emailA, emailB, `own.${stamp}@example.com`, `new.${stamp}@example.com`], [fileName]);
  }
});

test("a spreadsheet national ID is ignored and not stored", async () => {
  const stamp = `${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}d`;
  const phone = `09${String(23000000 + (Date.now() % 70000000)).slice(-8)}`;
  const e164 = `+886${phone.slice(1)}`;
  const name = `匯入身分${stamp}`;
  const email = `id.${stamp}@example.com`;
  const fileName = `id-${stamp}.csv`;
  const kept = "abc123";
  const incoming = `Q${stamp.slice(0, 9).toUpperCase()}`;
  await query(
    `INSERT INTO contacts (org_id, is_tenant, display_name, email, phone_e164, id_number_hash, locale)
     VALUES ($1, true, $2, $3, $4, $5, 'zh-TW')`,
    [ORG_ID, `既有${stamp}`, email, e164, kept],
  );
  try {
    const result = await commitImportBatch(admin, {
      fileName,
      rows: [
        {
          ...row({
            propertyName: name,
            address: `台北市中正區身分路${stamp}號`,
            ownerName: "身分屋主",
            ownerEmail: `idown.${stamp}@example.com`,
            tenantPhone: phone,
            tenantEmail: `idnew.${stamp}@example.com`,
          }),
          tenantId: incoming,
        },
      ],
    });
    assert.ok(result.errors.some((issue) => issue.key === "im_e_phone_name"));
    assert.equal(result.created.leases, 0);
    const contact = await query<{ hash: string; display_name: string; n: string }>(
      `SELECT id_number_hash AS hash, display_name, (SELECT count(*) FROM contacts c2 WHERE c2.org_id = $1 AND c2.phone_e164 = $2)::text AS n
         FROM contacts WHERE org_id = $1 AND phone_e164 = $2`,
      [ORG_ID, e164],
    );
    assert.equal(contact.rows.length, 1);
    assert.equal(contact.rows[0].n, "1");
    assert.equal(contact.rows[0].hash, kept);
    assert.equal(contact.rows[0].display_name, `既有${stamp}`);
    const leaked = await query<{ n: string }>(
      `SELECT count(*)::text AS n FROM contacts WHERE org_id = $1 AND (id_number_hash = $2 OR display_name = $2 OR notes = $2)`,
      [ORG_ID, incoming],
    );
    assert.equal(leaked.rows[0].n, "0");
    const props = await query<{ n: string }>(`SELECT count(*)::text AS n FROM properties WHERE name = $1`, [name]);
    assert.equal(props.rows[0].n, "0");
  } finally {
    await cleanup([name], [email, `idown.${stamp}@example.com`, `idnew.${stamp}@example.com`], [fileName]);
  }
});

test("a previous file name does not block the next import", async () => {
  const stamp = `${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}c`;
  const fileName = `cap-${stamp}.csv`;
  const name = `匯入上限${stamp}`;
  const ownerEmail = `cap.${stamp}@example.com`;
  await query(
    `INSERT INTO import_jobs (org_id, entity, column_map, status, rows_total, rows_ok, rows_failed, requested_by, finished_at)
     VALUES ($1, 'portfolio', $2::jsonb, 'succeeded', 2000, 2000, 0, $3, now())`,
    [ORG_ID, JSON.stringify({ fileName, kind: "bulk" }), USERS.admin],
  );
  try {
    const committed = await commitImportBatch(admin, {
      fileName,
      rows: [row({ propertyName: name, address: `台北市南港區上限路${stamp}號`, ownerName: "上限屋主", ownerEmail })],
    });
    assert.equal(committed.errors.length, 0);
    assert.equal(committed.created.properties, 1);
  } finally {
    await cleanup([name], [ownerEmail], [fileName]);
  }
});

test("a phone-only match with a different name is a row error", async () => {
  const stamp = `${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}n`;
  const phone = `09${String(24000000 + (Date.now() % 70000000)).slice(-8)}`;
  const e164 = `+886${phone.slice(1)}`;
  const name = `匯入姓名${stamp}`;
  const email = `name.${stamp}@example.com`;
  const fileName = `name-${stamp}.csv`;
  const kept = `既有姓名${stamp}`;
  await query(
    `INSERT INTO contacts (org_id, is_tenant, display_name, email, phone_e164, locale)
     VALUES ($1, true, $2, $3, $4, 'zh-TW')`,
    [ORG_ID, kept, email, e164],
  );
  try {
    const result = await commitImportBatch(admin, {
      fileName,
      rows: [row({ propertyName: name, address: `台北市松山區姓名路${stamp}號`, ownerName: "姓名屋主", ownerEmail: `nown.${stamp}@example.com`, tenantName: "不同姓名", tenantPhone: phone, tenantEmail: `nnew.${stamp}@example.com` })],
    });
    assert.ok(result.errors.some((issue) => issue.key === "im_e_phone_name"));
    assert.equal(result.created.tenants, 0);
    assert.equal(result.created.leases, 0);
    const contact = await query<{ display_name: string; n: string }>(
      `SELECT display_name, (SELECT count(*) FROM contacts c2 WHERE c2.org_id = $1 AND c2.phone_e164 = $2)::text AS n
         FROM contacts WHERE org_id = $1 AND phone_e164 = $2`,
      [ORG_ID, e164],
    );
    assert.equal(contact.rows.length, 1);
    assert.equal(contact.rows[0].n, "1");
    assert.equal(contact.rows[0].display_name, kept);
  } finally {
    await cleanup([name], [email, `nown.${stamp}@example.com`, `nnew.${stamp}@example.com`], [fileName]);
  }
});

test("a UI unit is reused by the import address key, including when the key was not stored", async () => {
  const stamp = `${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}k`;
  const street = `鍵路${stamp}號`;
  const address = `台北市中山區${street}`;
  const uiName = `畫面物件${stamp}`;
  const ownerEmail = `keyown.${stamp}@example.com`;
  const fileName = `key-${stamp}.csv`;
  const bareName = `未存鍵${stamp}`;
  const bareAddress = `台北市內湖區未存鍵${stamp}號`;
  try {
    const created = await createProperty(admin, {
      name: uiName,
      city: "台北市",
      district: "中山區",
      street,
      currency: "TWD",
      ownerMode: "new",
      ownerName: "鍵屋主",
      ownerPhone: "",
      ownerEmail,
      canViewTenantPhone: false,
      unitLabel: "5F",
      floor: "5",
      rentalMode: "whole_unit",
      rooms: [],
    });
    const stored = await query<{ address_key: string; import_address_key: string }>(
      `SELECT p.address_key, u.import_address_key
         FROM units u JOIN properties p ON p.id = u.property_id
        WHERE p.id = $1`,
      [created.propertyId],
    );
    assert.equal(stored.rows[0].address_key, addressKey(address));
    assert.equal(stored.rows[0].import_address_key, addressKey(address));
    const reused = await commitImportBatch(admin, {
      fileName,
      rows: [row({ propertyName: `匯入別名${stamp}`, address, ownerName: "鍵屋主", ownerEmail, unitLabel: "5F", tenantName: `鍵租客${stamp}`, tenantPhone: `09${String(31000000 + (Date.now() % 10000000)).slice(-8)}`, tenantEmail: `keyt.${stamp}@example.com` })],
    });
    assert.equal(reused.created.properties, 0);
    assert.equal(reused.created.units, 0);
    assert.equal(reused.reused.units, 1);
    assert.equal(reused.created.leases, 1);

    const jurisdiction = await query<{ id: string }>(`SELECT id::text FROM jurisdictions WHERE code = 'TW'`);
    const bare = await query<{ id: string }>(
      `INSERT INTO properties (org_id, name, address, address_display, country_code, jurisdiction_id, currency, timezone)
       VALUES ($1, $2, '{}'::jsonb, $3, 'TW', $4, 'TWD', 'Asia/Taipei') RETURNING id::text`,
      [ORG_ID, bareName, bareAddress, jurisdiction.rows[0].id],
    );
    await query(
      `INSERT INTO units (org_id, property_id, label, floor, rental_mode) VALUES ($1, $2, '8F', '8F', 'whole_unit')`,
      [ORG_ID, bare.rows[0].id],
    );
    const matched = await commitImportBatch(admin, {
      fileName: `bare-${fileName}`,
      rows: [row({ propertyName: `另一個名字${stamp}`, address: bareAddress, ownerName: "未存鍵屋主", ownerEmail: `bare.${stamp}@example.com`, unitLabel: "8F", tenantName: `未存鍵租客${stamp}`, tenantPhone: `09${String(32000000 + (Date.now() % 10000000)).slice(-8)}`, tenantEmail: `baret.${stamp}@example.com` })],
    });
    assert.equal(matched.created.units, 0);
    assert.equal(matched.reused.units, 1);
    const units = await query<{ n: string }>(
      `SELECT count(*)::text AS n FROM units WHERE property_id = $1 AND label = '8F' AND archived_at IS NULL`,
      [bare.rows[0].id],
    );
    assert.equal(units.rows[0].n, "1");
  } finally {
    await cleanup([uiName, `匯入別名${stamp}`, bareName, `另一個名字${stamp}`], [ownerEmail, `keyt.${stamp}@example.com`, `bare.${stamp}@example.com`, `baret.${stamp}@example.com`], [fileName, `bare-${fileName}`]);
  }
});

test("included electricity stays off the existing method check", async () => {
  const stamp = `${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}e`;
  const name = `電費包含${stamp}`;
  const ownerEmail = `elec.${stamp}@example.com`;
  const fileName = `elec-${stamp}.csv`;
  try {
    const result = await commitImportBatch(admin, {
      fileName,
      rows: [row({ propertyName: name, address: `台北市文山區電費路${stamp}號`, ownerName: "電費屋主", ownerEmail, electricity: "包含", unitLabel: "9F" })],
    });
    assert.equal(result.errors.length, 0);
    assert.equal(result.created.units, 1);
    const stored = await query<{ method: string | null; included: boolean }>(
      `SELECT u.electricity_method AS method, u.electricity_included AS included
         FROM units u JOIN properties p ON p.id = u.property_id
        WHERE p.name = $1 AND u.label = '9F'`,
      [name],
    );
    assert.equal(stored.rows[0].method, null);
    assert.equal(stored.rows[0].included, true);
  } finally {
    await cleanup([name], [ownerEmail], [fileName]);
  }
});

test("the bulk import migration applies a second time", async () => {
  const sql = readFileSync(new URL("../../supabase/migrations/20261023120000_bulk_import.sql", import.meta.url), "utf8");
  await withClient(async (client) => {
    await client.query(sql);
  });
  const column = await query<{ n: string }>(
    `SELECT count(*)::text AS n FROM information_schema.columns
      WHERE table_name = 'units' AND column_name = 'import_address_key'`,
  );
  assert.equal(column.rows[0].n, "1");
});

test("a failure inside the import writes none of the rows", async () => {
  const stamp = `${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}z`;
  const kept = `原子保留${stamp}`;
  const dropped = `原子失敗${stamp}`;
  const ownerEmail = `atom.${stamp}@example.com`;
  const fileName = `atom-${stamp}.csv`;
  const phoneA = `09${String(71000000 + (Date.now() % 1000000)).slice(-8)}`;
  const phoneB = `09${String(72000000 + (Date.now() % 1000000)).slice(-8)}`;
  try {
    await assert.rejects(() =>
      commitImportBatch(admin, {
        fileName,
        rows: [
          row({ propertyName: kept, address: `台北市中山區原子路${stamp}號`, ownerName: "原子屋主", ownerEmail, tenantName: "原子甲", tenantPhone: phoneA, tenantEmail: `a.${stamp}@example.com`, unitLabel: "1F" }),
          row({ propertyName: dropped, address: `台北市中山區原子路${stamp}號`, ownerName: "原子屋主", ownerEmail, tenantName: "原子乙", tenantPhone: phoneB, tenantEmail: `b.${stamp}@example.com`, unitLabel: "2F", notes: "bad\u0000byte" }),
        ],
      }),
    );
    const props = await query<{ n: string }>(`SELECT count(*)::text AS n FROM properties WHERE name = ANY($1::text[])`, [[kept, dropped]]);
    assert.equal(props.rows[0].n, "0");
  } finally {
    await cleanup([kept, dropped], [ownerEmail, `a.${stamp}@example.com`, `b.${stamp}@example.com`], [fileName]);
  }
});

test("one blocked row rejects the whole confirmed file", async () => {
  const stamp = `${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}y`;
  const name = `整批拒絕${stamp}`;
  const ownerEmail = `block.${stamp}@example.com`;
  const fileName = `block-${stamp}.csv`;
  try {
    const result = await commitImportBatch(admin, {
      fileName,
      rows: [
        row({ propertyName: name, address: `台北市大同區拒絕路${stamp}號`, ownerName: "拒絕屋主", ownerEmail, unitLabel: "1F", tenantPhone: `09${String(73000000).slice(-8)}`, tenantEmail: `ok.${stamp}@example.com` }),
        row({ propertyName: name, address: `台北市大同區拒絕路${stamp}號`, ownerName: "拒絕屋主", ownerEmail, unitLabel: "2F", tenantPhone: `09${String(74000000).slice(-8)}`, tenantEmail: `bad.${stamp}@example.com`, deposit: "90000" }),
      ],
    });
    assert.equal(result.created.leases, 0);
    assert.ok(result.errors.some((issue) => issue.key === "im_e_dep"));
    const props = await query<{ n: string }>(`SELECT count(*)::text AS n FROM properties WHERE name = $1`, [name]);
    assert.equal(props.rows[0].n, "0");
  } finally {
    await cleanup([name], [ownerEmail, `ok.${stamp}@example.com`, `bad.${stamp}@example.com`], [fileName]);
  }
});

test("an xlsx with numeric cells saves the confirmed row", async () => {
  const stamp = `${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}x`;
  const name = `試算表${stamp}`;
  const ownerEmail = `sheet.${stamp}@example.com`;
  const fileName = `sheet-${stamp}.xlsx`;
  const headers = templateHeaders("zh-TW");
  const values = Object.fromEntries(headers.map((header) => [header, ""])) as Record<string, string>;
  values["物件名稱"] = name;
  values["地址"] = `台北市松山區表格路${stamp}號`;
  values["屋主姓名"] = "表格屋主";
  values["屋主 Email"] = ownerEmail;
  values["出租型態"] = "整層";
  values["戶別／樓層"] = "3F";
  values["月租"] = "9500";
  values["租客姓名"] = "表格租客";
  values["租客電話"] = "912000555";
  values["租客 Email"] = `sheet-tenant.${stamp}@example.com`;
  values["起租日"] = excelSerial("2026-11-01");
  values["到期日"] = excelSerial("2027-10-31");
  values["押金"] = "19000";
  values["繳租日"] = "5";
  try {
    const sheet = await readSpreadsheet(fileName, numericXlsx([headers, headers.map((header) => values[header] ?? "")]));
    const rows = tableToRows(sheet.rows, matchColumns(sheet.rows[0] ?? []));
    const first = await commitImportBatch(admin, { fileName, rows });
    assert.equal(first.errors.length, 0);
    assert.equal(first.created.leases, 1);
    const saved = await query<{ start: string; phone: string; hash: string | null }>(
      `SELECT l.start_date::text AS start, c.phone_e164 AS phone, c.id_number_hash AS hash
         FROM leases l
         JOIN properties p ON p.id = l.property_id
         JOIN lease_parties lp ON lp.lease_id = l.id AND lp.role = 'primary'
         JOIN contacts c ON c.id = lp.contact_id
        WHERE p.name = $1`,
      [name],
    );
    assert.equal(saved.rows.length, 1);
    assert.equal(saved.rows[0].start, "2026-11-01");
    assert.equal(saved.rows[0].phone, "+886912000555");
    assert.equal(saved.rows[0].hash, null);
    const again = await commitImportBatch(admin, { fileName, rows });
    assert.equal(again.created.leases, 0);
    assert.equal(again.duplicateRows, 1);
    const count = await query<{ n: string }>(
      `SELECT count(*)::text AS n FROM leases l JOIN properties p ON p.id = l.property_id WHERE p.name = $1`,
      [name],
    );
    assert.equal(count.rows[0].n, "1");
  } finally {
    await cleanup([name], [ownerEmail, `sheet-tenant.${stamp}@example.com`], [fileName]);
  }
});

test("five hundred rows commit in one transaction", async () => {
  const stamp = `${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}w`;
  const name = `五百筆${stamp}`;
  const ownerEmail = `bulk500.${stamp}@example.com`;
  const fileName = `bulk500-${stamp}.xlsx`;
  const emails = [ownerEmail];
  const rows = [];
  for (let i = 1; i <= 500; i += 1) {
    const email = `t${i}.${stamp}@example.com`;
    emails.push(email);
    rows.push(
      row({
        line: i + 1,
        propertyName: name,
        address: `台北市大安區五百路${stamp}號`,
        ownerName: "五百屋主",
        ownerEmail,
        unitLabel: `B${String(i).padStart(4, "0")}`,
        tenantName: `租客${i}`,
        tenantPhone: `09${String(88000000 + i).slice(-8)}`,
        tenantEmail: email,
      }),
    );
  }
  try {
    const started = performance.now();
    const result = await commitImportBatch(admin, { fileName, rows });
    const elapsed = performance.now() - started;
    assert.equal(result.errors.length, 0);
    assert.equal(result.created.properties, 1);
    assert.equal(result.created.leases, 500);
    assert.ok(elapsed < 45_000, `import took ${Math.round(elapsed)}ms`);
    const saved = await query<{ n: string }>(
      `SELECT count(*)::text AS n FROM leases l JOIN properties p ON p.id = l.property_id WHERE p.name = $1`,
      [name],
    );
    assert.equal(saved.rows[0].n, "500");
  } finally {
    await cleanup([name], emails, [fileName]);
  }
});

function excelSerial(iso: string) {
  const [year, month, day] = iso.split("-").map(Number);
  return String(Math.round((Date.UTC(year, month - 1, day) - Date.UTC(1899, 11, 30)) / 86400000));
}

function numericXlsx(rows: string[][]) {
  const strings: string[] = [];
  const index = new Map<string, number>();
  const sheet = rows
    .map((row, rowIndex) => {
      const cells = row.map((value, column) => {
        const ref = `${columnLetters(column)}${rowIndex + 1}`;
        if (rowIndex > 0 && /^\d+(\.\d+)?$/.test(value)) return `<c r="${ref}"><v>${value}</v></c>`;
        let at = index.get(value);
        if (at === undefined) {
          at = strings.length;
          strings.push(value);
          index.set(value, at);
        }
        return `<c r="${ref}" t="s"><v>${at}</v></c>`;
      });
      return `<row r="${rowIndex + 1}">${cells.join("")}</row>`;
    })
    .join("");
  const shared = strings.map((value) => `<si><t xml:space="preserve">${value.replaceAll("&", "&amp;")}</t></si>`).join("");
  const files: Record<string, string> = {
    "[Content_Types].xml": `<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/sharedStrings.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml"/></Types>`,
    "xl/workbook.xml": `<?xml version="1.0" encoding="UTF-8"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="匯入" sheetId="1" r:id="rId1"/></sheets></workbook>`,
    "xl/_rels/workbook.xml.rels": `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/sharedStrings" Target="sharedStrings.xml"/></Relationships>`,
    "xl/sharedStrings.xml": `<?xml version="1.0" encoding="UTF-8"?><sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">${shared}</sst>`,
    "xl/worksheets/sheet1.xml": `<?xml version="1.0" encoding="UTF-8"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${sheet}</sheetData></worksheet>`,
  };
  return storedZip(files);
}

function columnLetters(index: number) {
  let n = index + 1;
  let out = "";
  while (n > 0) {
    const rem = (n - 1) % 26;
    out = String.fromCharCode(65 + rem) + out;
    n = Math.floor((n - 1) / 26);
  }
  return out;
}

function storedZip(files: Record<string, string>) {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const [name, xml] of Object.entries(files)) {
    const data = Buffer.from(xml);
    const nameBytes = Buffer.from(name);
    const crc = crc32(data) >>> 0;
    const local = Buffer.concat([
      u32(0x04034b50), u16(20), u16(0), u16(0), u16(0), u16(0), u32(crc), u32(data.length), u32(data.length), u16(nameBytes.length), u16(0), nameBytes, data,
    ]);
    const central = Buffer.concat([
      u32(0x02014b50), u16(20), u16(20), u16(0), u16(0), u16(0), u16(0), u32(crc), u32(data.length), u32(data.length), u16(nameBytes.length), u16(0), u16(0), u16(0), u16(0), u32(0), u32(offset), nameBytes,
    ]);
    offset += local.length;
    locals.push(local);
    centrals.push(central);
  }
  const centralDir = Buffer.concat(centrals);
  const eocd = Buffer.concat([u32(0x06054b50), u16(0), u16(0), u16(centrals.length), u16(centrals.length), u32(centralDir.length), u32(offset), u16(0)]);
  return new Uint8Array(Buffer.concat([...locals, centralDir, eocd]));
}

function u16(value: number) {
  const bytes = Buffer.alloc(2);
  bytes.writeUInt16LE(value);
  return bytes;
}

function u32(value: number) {
  const bytes = Buffer.alloc(4);
  bytes.writeUInt32LE(value >>> 0);
  return bytes;
}
