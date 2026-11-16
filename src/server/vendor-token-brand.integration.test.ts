import assert from "node:assert/strict";
import test from "node:test";
import { randomBytes, randomUUID } from "node:crypto";
import { withClient } from "./db";
import { cloneTestDatabase } from "./test-database-clone";
import { disposableDbUrl } from "./test-disposable-db";
import { ORG_ID, ORG2_ID } from "./ids";
import { loadVendorJob } from "./vendor-repair";
import { hashVendorToken } from "./vendor-repair-rules";
import { vendorTokenBrand } from "./vendor-token-brand";

// Mac handoff: existing migrated/seeded local disposable DB only. This file never migrates
// or uses a shared/staging target. All fixture writes disappear with its private clone.
disposableDbUrl(process.env.DATABASE_URL, process.env.CONDOLA_RLS_DISPOSABLE);

test("V-TOKEN real bearer gateway / per-org presentation / isolation", async t => {
  const clone = await cloneTestDatabase();
  try {
    await withClient(client => client.query(`UPDATE organizations
      SET plan_tier='beta', feature_flags=coalesce(feature_flags,'{}'::jsonb)
        || '{"brand_v2":true,"brand_v3":true,"vendor_link":false,"vendor_dispatch":true}'::jsonb
      WHERE id=ANY($1::uuid[])`, [[ORG_ID, ORG2_ID]]));
    async function issue(org: string, suffix: string) {
      const token = randomBytes(32).toString("base64url"), ticketId = randomUUID(), jobId = randomUUID();
      const title = `VTOK fixture ${suffix}`;
      const fixture = await withClient(async client => {
        const property = (await client.query(`SELECT id,name FROM properties WHERE org_id=$1 ORDER BY id LIMIT 1`, [org])).rows[0];
        assert.ok(property, "migrated demo seed includes a property in each org");
        await client.query(`INSERT INTO maintenance_tickets(id,org_id,ticket_number,property_id,title,description,status)
          SELECT $1,$2,coalesce(max(ticket_number),0)+1,$3,$4,$4,'assigned' FROM maintenance_tickets WHERE org_id=$2`,
        [ticketId, org, property.id, title]);
        await client.query(`INSERT INTO repair_vendor_jobs(id,org_id,ticket_id,vendor_name,vendor_phone,contact_window,token_hash,expires_at)
          VALUES($1,$2,$3,$4,'+886912000111','Monday',$5,clock_timestamp()+interval '1 day')`,
        [jobId, org, ticketId, `Vendor ${suffix}`, hashVendorToken(token)]);
        const company = (await client.query("SELECT name FROM organizations WHERE id=$1", [org])).rows[0].name;
        return { property: property.name, company };
      });
      return { ...fixture, org, token, ticketId, jobId, title, vendor: `Vendor ${suffix}` };
    }
    const a = await issue(ORG_ID, "A"), otherSameOrg = await issue(ORG_ID, "other"), b = await issue(ORG2_ID, "B");
    await t.test("only the bearer job and its org's context are returned; no sibling/history data", async () => {
      const view = await loadVendorJob(a.token);
      assert.equal(view?.title, a.title);
      assert.deepEqual(await vendorTokenBrand(a.token, true), { name: a.vendor, company: a.company, property: a.property, status: "assigned" });
      assert.doesNotMatch(JSON.stringify(view), new RegExp(`${otherSameOrg.title}|${b.title}`));
      assert.equal((await vendorTokenBrand(b.token, true))?.company, b.company);
    });
    await t.test("org B OFF cannot borrow org A's ON; OFF legacy data is identical", async () => {
      const before = JSON.stringify(await loadVendorJob(b.token));
      await withClient(client => client.query(`UPDATE organizations SET feature_flags=feature_flags||'{"brand_v3":false}'::jsonb WHERE id=$1`, [ORG2_ID]));
      assert.equal(await vendorTokenBrand(b.token, true), null);
      assert.ok(await vendorTokenBrand(a.token, true));
      assert.equal(JSON.stringify(await loadVendorJob(b.token)), before);
    });
    await t.test("metadata read is read-only and does not bypass the loader's sharing redaction", async () => {
      const snapshot = () => withClient(async client => (await client.query(`SELECT md5(string_agg(row_to_json(j)::text,'' ORDER BY j.id)) hash FROM repair_vendor_jobs j`)).rows[0].hash);
      const before = await snapshot();
      const hidden = await vendorTokenBrand(a.token, false);
      assert.equal(hidden?.property, "");
      assert.equal(await snapshot(), before);
    });
    await t.test("invalid, unknown, expired, revoked and inactive tokens never activate v3", async () => {
      for (const token of ["invalid", randomBytes(32).toString("base64url")]) {
        assert.equal(await loadVendorJob(token), null); assert.equal(await vendorTokenBrand(token, true), null);
      }
      for (const state of ["expired", "revoked", "inactive"] as const) {
        const fixture = await issue(ORG_ID, state);
        const update = { expired: "expires_at=clock_timestamp()-interval '1 second'", revoked: "revoked_at=clock_timestamp()", inactive: "active=false" }[state];
        await withClient(client => client.query(`UPDATE repair_vendor_jobs SET ${update} WHERE id=$1`, [fixture.jobId]));
        assert.equal(await loadVendorJob(fixture.token), null);
        assert.equal(await vendorTokenBrand(fixture.token, true), null);
      }
    });
    await t.test("missing / string brand_v3 flags fail closed", async () => {
      for (const flag of [null, "true"]) {
        await withClient(client => client.query(`UPDATE organizations SET feature_flags=(feature_flags-'brand_v3') || $2::jsonb WHERE id=$1`,
          [ORG_ID, JSON.stringify(flag === null ? {} : { brand_v3: flag })]));
        assert.equal(await vendorTokenBrand(a.token, true), null);
        assert.equal((await loadVendorJob(a.token))?.title, a.title);
      }
    });
  } finally { await clone.cleanup(); }
});
