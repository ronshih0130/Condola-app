import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { Client } from "pg";
import { commitImportBatch, previewImport } from "./import-batch";
import { ORG_ID, USERS } from "./ids";
import { disposableDbUrl } from "./test-disposable-db";
import { insertTestAuthSession } from "./test-auth-session";
import type { Session } from "./types";

// B-006 A3: a regional (ROC 民國) date fixture is interpreted under the configured canonical
// jurisdiction (TW/TWD) and persisted as Gregorian dates; under a non-TW profile the same
// fixture is refused (im_region_unavailable) with zero new records.
const url = disposableDbUrl(process.env.DATABASE_URL, process.env.CONDOLA_RLS_DISPOSABLE).href;

test("ROC dates follow the configured TW jurisdiction; a US profile refuses the same fixture without writes", async () => {
  const db = new Client({ connectionString: url }); await db.connect();
  const oldEnv = process.env.IMPORT_ERROR_DETAILS_ENABLED;
  const org = (await db.query(`SELECT country_code,jurisdiction_id,default_currency,timezone,feature_flags FROM organizations WHERE id=$1`, [ORG_ID])).rows[0];
  const suffix = randomUUID().slice(0, 8), name = `b006-roc-${suffix}`, blocked = `b006-roc-blocked-${suffix}`;
  const session: Session = { userId: USERS.admin, sessionId: "", email: "", name: "Synthetic", kind: "staff", role: "admin",
    orgId: ORG_ID, liveOrgId: ORG_ID, environment: "live", locale: "zh-TW", calendar: "gregorian", leaseId: null };
  let propertyId = "";
  try {
    session.sessionId = await insertTestAuthSession(db, USERS.admin);
    process.env.IMPORT_ERROR_DETAILS_ENABLED = "true";
    const j = await db.query<{ id: string; code: string }>(`SELECT id::text,code FROM jurisdictions WHERE code IN ('TW','US-CA')`);
    const tw = j.rows.find((r) => r.code === "TW")!.id, ca = j.rows.find((r) => r.code === "US-CA")!.id;
    await db.query(`UPDATE organizations SET country_code='TW',jurisdiction_id=$2,default_currency='TWD',timezone='Asia/Taipei',
      feature_flags=feature_flags || '{"import_error_details":true}'::jsonb WHERE id=$1`, [ORG_ID, tw]);
    const row = { line: 4, propertyName: name, address: `台北民國路${suffix}號`, ownerName: "測試屋主", ownerEmail: "",
      rentalMode: "整層", unitLabel: "3F", roomLabel: "", roomType: "", area: "10", rent: "12000", tenantName: "測試租客",
      tenantPhone: "0912777600", tenantEmail: "", startDate: "116/01/05", endDate: "117/01/05", deposit: "24000",
      dueDay: "5", electricity: "", rate: "", billKwh: "", billAmount: "", opening: "", depositReason: "", rateReason: "", notes: "" };
    assert.deepEqual(await previewImport(session, { fileName: "roc.csv", rows: [row] }), []);
    const created = await commitImportBatch(session, { fileName: "roc.csv", rows: [row] });
    assert.equal(created.created.leases, 1);
    const lease = (await db.query<{ property_id: string; start_date: string; end_date: string }>(
      `SELECT p.id::text property_id,l.start_date::text,l.end_date::text FROM properties p JOIN leases l ON l.property_id=p.id WHERE p.org_id=$1 AND p.name=$2`, [ORG_ID, name])).rows[0];
    propertyId = lease.property_id;
    assert.deepEqual([lease.start_date, lease.end_date], ["2027-01-05", "2028-01-05"]);
    await db.query(`UPDATE organizations SET country_code='US',jurisdiction_id=$2,default_currency='USD' WHERE id=$1`, [ORG_ID, ca]);
    // Organization-scoped footprint of every table an import can write.
    const footprint = async () => (await db.query(`SELECT
      (SELECT count(*) FROM properties WHERE org_id=$1) properties, (SELECT count(*) FROM units WHERE org_id=$1) units,
      (SELECT count(*) FROM rooms WHERE org_id=$1) rooms, (SELECT count(*) FROM contacts WHERE org_id=$1) contacts,
      (SELECT count(*) FROM property_owners WHERE org_id=$1) owners, (SELECT count(*) FROM leases WHERE org_id=$1) leases,
      (SELECT count(*) FROM lease_parties WHERE org_id=$1) parties, (SELECT count(*) FROM lease_charges WHERE org_id=$1) charges,
      (SELECT count(*) FROM audit_log WHERE org_id=$1) audits, (SELECT count(*) FROM import_jobs WHERE org_id=$1) import_jobs,
      (SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY t.id),'[]'::jsonb) FROM listing_terms t WHERE t.org_id=$1) listing_terms`, [ORG_ID])).rows[0];
    for (const mode of [previewImport, commitImportBatch]) {
      const before = await footprint();
      await assert.rejects(mode(session, { fileName: "roc.csv", rows: [{ ...row, propertyName: blocked, tenantPhone: "0912777601" }] }), /im_region_unavailable/);
      assert.deepEqual(await footprint(), before, "a refused import writes nothing in the organization");
    }
  } finally {
    if (oldEnv === undefined) delete process.env.IMPORT_ERROR_DETAILS_ENABLED; else process.env.IMPORT_ERROR_DETAILS_ENABLED = oldEnv;
    try {
      try {
        if (session.sessionId) await db.query(`DELETE FROM auth_sessions WHERE id=$1::uuid`, [session.sessionId]);
        if (propertyId) { await db.query(`DELETE FROM leases WHERE property_id=$1`, [propertyId]); await db.query(`DELETE FROM units WHERE property_id=$1`, [propertyId]); await db.query(`DELETE FROM properties WHERE id=$1`, [propertyId]); }
      } finally {
        await db.query(`UPDATE organizations SET country_code=$2,jurisdiction_id=$3,default_currency=$4,timezone=$5,feature_flags=$6 WHERE id=$1`,
          [ORG_ID, org.country_code, org.jurisdiction_id, org.default_currency, org.timezone, org.feature_flags]);
      }
    } finally { await db.end(); }
  }
});
