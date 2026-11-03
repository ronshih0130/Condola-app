import assert from "node:assert/strict";
import test from "node:test";
import { Client } from "pg";
import { USERS } from "./ids";
import { disposableDbUrl } from "./test-disposable-db";
import { resolveDepositPolicy } from "./deposit-rules";
import { insertSandboxOrg } from "./sandbox";
import { cloneTestDatabase } from "./test-database-clone";
import { createLease, createProperty, signLease } from "./domain";
import { query, withClient } from "./db";
import { insertTestAuthSession } from "./test-auth-session";
import type { Session } from "./types";

const target = disposableDbUrl(process.env.DATABASE_URL, process.env.CONDOLA_RLS_DISPOSABLE);
let url = target.href;
let clone: Awaited<ReturnType<typeof cloneTestDatabase>> | undefined;
test.before(async () => { clone = await cloneTestDatabase(); url = clone.url; });
test.after(async () => { await clone?.cleanup(); });

test("B007 rule resolver and direct lease writes enforce rollout, regional rules and metadata", async () => {
  const client = new Client({ connectionString: url });
  await client.connect();
  try {
    await client.query("BEGIN");
    const org = (await client.query<{ id: string }>(`INSERT INTO organizations(name,country_code,default_currency)
      VALUES ('B007 fixture','TW','TWD') RETURNING id::text`)).rows[0].id;
    await client.query(`INSERT INTO org_members(org_id,user_id,role) VALUES ($1,$2,'admin')`, [org, USERS.admin]);
    await client.query(`SELECT set_config('request.jwt.claim.sub',$1,true), set_config('request.jwt.claim.role','authenticated',true),
      set_config('app.active_org_id',$2,true), set_config('app.env','live',true)`, [USERS.admin, org]);
    async function space(code: string, currency: string) {
      const property = (await client.query<{ id: string }>(`INSERT INTO properties(org_id,name,country_code,jurisdiction_id,currency,timezone,default_rental_mode)
        SELECT $1,$2, CASE WHEN $3='TW' THEN 'TW' ELSE 'US' END,j.id,$4,'Asia/Taipei','whole_unit'
        FROM jurisdictions j WHERE j.code=$3 RETURNING id::text`, [org, `B007 ${code}`, code, currency])).rows[0].id;
      const unit = (await client.query<{ id: string }>(`INSERT INTO units(org_id,property_id,label,rental_mode)
        VALUES ($1,$2,'B007','whole_unit') RETURNING id::text`, [org, property])).rows[0].id;
      return { property, unit, currency };
    }
    const tw = await space("TW", "TWD");
    const us = await space("US", "USD");
    const ca = await space("US-CA", "USD");
    const create = async (space: typeof tw, rent: number, deposit: number, months: number | null, reason: string | null = null) => {
      const row = await client.query<{ id: string }>(`INSERT INTO leases(org_id,property_id,unit_id,target_unit_id,status,start_date,currency,rent_amount_minor,deposit_amount_minor,deposit_months,deposit_override_reason,deposit_overridden_by,deposit_overridden_at)
        VALUES ($1,$2,$3,$3,'draft','2026-01-01',$4,$5,$6,$7,$8,CASE WHEN $8::text IS NULL THEN NULL ELSE $9::uuid END,CASE WHEN $8::text IS NULL THEN NULL ELSE now() END) RETURNING id::text`,
      [org, space.property, space.unit, space.currency, rent, deposit, months, reason, USERS.admin]);
      return row.rows[0].id;
    };
    let counter = 0;
    const fails = async (fn: () => Promise<unknown>, code = "23514") => {
      const name = `b007_${++counter}`;
      await client.query(`SAVEPOINT ${name}`);
      try { await assert.rejects(fn, (error: unknown) => (error as { code?: string }).code === code); } finally { await client.query(`ROLLBACK TO SAVEPOINT ${name}`); await client.query(`RELEASE SAVEPOINT ${name}`); }
    };
    assert.equal((await resolveDepositPolicy(client, org, us.property, "2026-01-01")).regionalEnabled, false);
    await fails(() => create(us, 10000, 30000, 3));
    await fails(() => create(tw, 100000, 300000, 1)); // forged months vs amount
    await fails(() => create(tw, 0, 100, null));
    await client.query(`UPDATE organizations SET feature_flags=feature_flags || '{"deposit_rule_hints":true}'::jsonb WHERE id=$1`, [org]);
    assert.equal((await resolveDepositPolicy(client, org, tw.property, "2026-01-01")).regionalEnabled, false);
    await client.query(`UPDATE platform_settings SET value='{"enabled":true,"allowed_org_ids":[]}'::jsonb WHERE key='deposit_rule_hints'`);
    assert.equal((await resolveDepositPolicy(client, org, tw.property, "2026-01-01")).regionalEnabled, false);
    await client.query(`UPDATE platform_settings SET value=jsonb_build_object('enabled','true'::text,'allowed_org_ids',jsonb_build_array($1::text)) WHERE key='deposit_rule_hints'`, [org]);
    assert.equal((await resolveDepositPolicy(client, org, tw.property, "2026-01-01")).regionalEnabled, false);
    await client.query(`UPDATE platform_settings SET value=jsonb_build_object('enabled',true,'allowed_org_ids',jsonb_build_array($1::text)) WHERE key='deposit_rule_hints'`, [org]);
    const sandbox = await insertSandboxOrg(client, org, USERS.admin);
    const sandboxProperty = (await client.query<{ id: string }>(`INSERT INTO properties(org_id,name,country_code,jurisdiction_id,currency,timezone,default_rental_mode)
      SELECT $1,'B007 sandbox','TW',id,'TWD','Asia/Taipei','whole_unit' FROM jurisdictions WHERE code='TW' RETURNING id::text`, [sandbox])).rows[0].id;
    assert.equal((await resolveDepositPolicy(client, sandbox, sandboxProperty, "2026-01-01")).regionalEnabled, false);
    await client.query(`UPDATE platform_settings SET value=jsonb_build_object('enabled',true,'allowed_org_ids',jsonb_build_array($1::text,$2::text)) WHERE key='deposit_rule_hints'`, [org, sandbox]);
    assert.equal((await resolveDepositPolicy(client, sandbox, sandboxProperty, "2026-01-01")).regionalEnabled, true);
    await client.query(`UPDATE organizations SET feature_flags=feature_flags || '{"deposit_rule_hints":"true"}'::jsonb WHERE id=$1`, [sandbox]);
    assert.equal((await resolveDepositPolicy(client, sandbox, sandboxProperty, "2026-01-01")).regionalEnabled, false);
    assert.deepEqual((await resolveDepositPolicy(client, org, us.property, "2026-01-01")).maxMonths, null);
    await client.query("SAVEPOINT authenticated_client");
    try {
      await client.query("SET LOCAL ROLE authenticated");
      await fails(() => create(tw, 100000, 300000, 2));
      await fails(async () => {
        await client.query(`SELECT set_config('request.jwt.claim.sub',$1,true),set_config('request.jwt.claim.role','service_role',true)`, [USERS.tenant]);
        return client.query(`SELECT app.b007_lock_deposit_policy($1)`, [org]);
      }, "42501");
      await client.query(`SELECT set_config('request.jwt.claim.sub',$1,true),set_config('request.jwt.claim.role','authenticated',true)`, [USERS.admin]);
      await fails(() => client.query(`INSERT INTO leases(org_id,property_id,unit_id,target_unit_id,status,start_date,currency,rent_amount_minor,deposit_amount_minor,deposit_months,deposit_override_reason,deposit_overridden_by,deposit_overridden_at)
        VALUES ($1,$2,$3,$3,'draft','2026-01-01','TWD',100000,300000,3,'forged',$4,now())`, [org, tw.property, tw.unit, USERS.manager]), "42501");
    } finally {
      await client.query("ROLLBACK TO SAVEPOINT authenticated_client");
      await client.query("RELEASE SAVEPOINT authenticated_client");
    }
    await create(us, 10000, 30000, 3); // no implicit Taiwan cap
    await fails(() => create(tw, 100000, 250000, 2.5));
    const stamped = (await client.query<{ at: string }>(`INSERT INTO leases(org_id,property_id,unit_id,target_unit_id,status,start_date,currency,rent_amount_minor,deposit_amount_minor,deposit_months,deposit_override_reason,deposit_overridden_by,deposit_overridden_at)
      VALUES ($1,$2,$3,$3,'draft','2026-01-01','TWD',100000,250000,2.5,'timestamp fixture',$4,'2000-01-01') RETURNING deposit_overridden_at::text AS at`, [org, tw.property, tw.unit, USERS.admin])).rows[0].at;
    assert.ok(new Date(stamped).getTime() > Date.parse("2020-01-01T00:00:00Z"));
    const overridden = await create(tw, 100000, 250000, 2.5, "fixture reason");
    const before = (await client.query<{ by: string; at: string }>(`SELECT deposit_overridden_by::text AS by, deposit_overridden_at::text AS at FROM leases WHERE id=$1`, [overridden])).rows[0];
    await client.query(`UPDATE leases SET status='pending_signature' WHERE id=$1`, [overridden]);
    const kept = (await client.query<{ by: string; at: string }>(`SELECT deposit_overridden_by::text AS by, deposit_overridden_at::text AS at FROM leases WHERE id=$1`, [overridden])).rows[0];
    assert.deepEqual(kept, before);
    await fails(() => client.query(`UPDATE leases SET rent_amount_minor=120000,deposit_amount_minor=300000 WHERE id=$1`, [overridden]));
    await client.query(`UPDATE leases SET deposit_months=2,deposit_amount_minor=200000 WHERE id=$1`, [overridden]);
    const below = (await client.query<{ by: string; at: string }>(`SELECT deposit_overridden_by::text AS by,deposit_overridden_at::text AS at FROM leases WHERE id=$1`, [overridden])).rows[0];
    assert.deepEqual(below, before);
    await fails(() => client.query(`UPDATE leases SET deposit_override_reason=NULL,deposit_overridden_by=NULL,deposit_overridden_at=NULL WHERE id=$1`, [overridden]));
    await create(tw, 100, 300, 2.5, "whole-dollar rounding");
    await create(us, 10001, 15002, 1.5); // minor-unit half rounding
    const quarterly = await create(us, 12000, 24000, 2);
    // A quarterly rent of 12000 minor units has a monthly basis of 4000.
    await client.query(`UPDATE leases SET rent_frequency='quarterly',deposit_amount_minor=8000,deposit_months=2 WHERE id=$1`, [quarterly]);
    await fails(() => client.query(`UPDATE leases SET rent_frequency='quarterly',deposit_amount_minor=24000,deposit_months=2 WHERE id=$1`, [quarterly]));
    // A selected malformed rule is an error, not an unlimited threshold.
    const malformedRule = (await client.query<{ id: string }>(`INSERT INTO jurisdiction_rules(jurisdiction_id,org_id,rule_key,value,enforcement,effective_from)
      SELECT jurisdiction_id,$1,'deposit.max_months','{"max_months":"2"}'::jsonb,'hard_block','2028-01-01' FROM properties WHERE id=$2 RETURNING id::text`, [org, tw.property])).rows[0].id;
    assert.equal((await resolveDepositPolicy(client, org, tw.property, "2028-01-01")).maxMonths, 2);
    await client.query(`UPDATE jurisdiction_rules SET value='{"max_months":" 2e0 "}'::jsonb WHERE id=$1`, [malformedRule]);
    assert.equal((await resolveDepositPolicy(client, org, tw.property, "2028-01-01")).maxMonths, 2);
    for (const enforcement of ["hard_block", "override_required"]) {
      for (const value of ['{}', '{"max_months":"NaN"}', '{"max_months":-1}', '{"max_months":false}', '{"max_months":[]}', '{"max_months":"2x"}']) {
        await client.query(`UPDATE jurisdiction_rules SET enforcement=$2::rule_enforcement,value=$3::jsonb WHERE id=$1`, [malformedRule, enforcement, value]);
        await fails(() => resolveDepositPolicy(client, org, tw.property, "2028-01-01"));
      }
      await client.query(`UPDATE jurisdiction_rules SET enforcement=$2::rule_enforcement,value='{"max_months":null}'::jsonb WHERE id=$1`, [malformedRule, enforcement]);
      assert.equal((await resolveDepositPolicy(client, org, tw.property, "2028-01-01")).maxMonths, null);
    }
    await client.query(`DELETE FROM jurisdiction_rules WHERE id=$1`, [malformedRule]);
    const dated = await create(tw, 100000, 200000, 2);
    await client.query(`INSERT INTO jurisdiction_rules(jurisdiction_id,org_id,rule_key,value,enforcement,effective_from)
      SELECT jurisdiction_id,$1,'deposit.max_months','{"max_months":1}'::jsonb,'hard_block','2030-01-01' FROM properties WHERE id=$2`, [org, tw.property]);
    assert.equal((await resolveDepositPolicy(client, org, tw.property, "2029-12-31")).maxMonths, 2);
    assert.equal((await resolveDepositPolicy(client, org, tw.property, "2030-01-01")).enforcement, "hard_block");
    await fails(() => client.query(`UPDATE leases SET start_date='2030-01-01' WHERE id=$1`, [dated]));
    const usdTwCurrency = await space("US", "TWD");
    const moving = await create(usdTwCurrency, 100000, 200000, 2);
    await client.query(`UPDATE leases SET start_date='2030-01-01' WHERE id=$1`, [moving]);
    await fails(() => client.query(`UPDATE leases SET unit_id=$2,target_unit_id=$2 WHERE id=$1`, [moving, tw.unit]));
    const warn = await create(ca, 10000, 15000, 1.5); // configured CA warning, no new legal rule
    const outcome = (await client.query<{ outcome: string }>(`SELECT outcome::text FROM rule_check_results WHERE entity_id=$1 ORDER BY checked_at DESC LIMIT 1`, [warn])).rows[0].outcome;
    assert.equal(outcome, "warn");
    const check = (await client.query<{ outcome: string; observed: { deposit_amount_minor: number } }>(`SELECT outcome::text,observed FROM rule_check_results WHERE entity_id=$1 AND outcome='overridden' ORDER BY checked_at DESC LIMIT 1`, [overridden])).rows[0];
    assert.equal(check.outcome, "overridden");
    assert.equal(check.observed.deposit_amount_minor, 250000);
  } finally {
    await client.query("ROLLBACK");
    await client.end();
  }
});


test("B007 actual createLease uses the selected property's configured warning rule", async () => {
  const session: Session = { userId: USERS.admin, sessionId: await withClient(c=>insertTestAuthSession(c,USERS.admin)), email: "b007@example.com", name: "Fixture", kind: "staff", role: "admin", orgId: "10000000-0000-4000-8000-000000000001", liveOrgId: "10000000-0000-4000-8000-000000000001", environment: "live", locale: "en", calendar: "gregorian", leaseId: null };
  await query(`UPDATE organizations SET feature_flags=feature_flags || '{"deposit_rule_hints":true}'::jsonb WHERE id=$1`, [session.orgId]);
  await query(`UPDATE platform_settings SET value=jsonb_build_object('enabled',true,'allowed_org_ids',jsonb_build_array($1::text)) WHERE key='deposit_rule_hints'`, [session.orgId]);
  const property = await createProperty(session, {
    name: "B007 US fixture", city: "Sunnyvale", district: "", street: "Fixture 1", currency: "USD", ownerMode: "new", ownerName: "Fixture owner", ownerPhone: "0912000111", ownerEmail: "b007-owner@example.com", canViewTenantPhone: false, unitLabel: "A", floor: "1", rentalMode: "by_room", rooms: [{ label: "A", roomType: "suite", baseRentMajor: 100 }, { label: "B", roomType: "suite", baseRentMajor: 100 }],
  });
  assert.equal(property.roomIds.length, 2);
  const lease = await createLease(session, {
    roomId: property.roomIds[0], tenantName: "Fixture tenant", tenantPhone: "0912000222", tenantEmail: "b007-tenant@example.com", lineUserId: "", startDate: "2026-12-01", endDate: "2027-11-30", rentMajor: 100, depositMonths: 3, depositReason: "", dueDay: 5, splitMethod: "even", periodStart: "2026-12-01", periodEnd: "2026-12-31", billTotalMajor: null, usageKwh: null, rateMajor: null, rateSource: "bill_average", overrideReason: "", subUsages: [],
  });
  assert.equal(lease.depositWarn, true);
  const result = await query<{ amount: string; months: string; reason: string | null }>(`SELECT deposit_amount_minor::text AS amount,deposit_months::text AS months,deposit_override_reason AS reason FROM leases WHERE id=$1`, [lease.leaseId]);
  assert.deepEqual(result.rows[0], { amount: "30000", months: "3.00", reason: null });

  // The existing service transaction signs as manager first, then the actual
  // tenant is the final signer. B-007 is OFF and the deposit is below the cap.
  await query(`UPDATE platform_settings SET value='{"enabled":false,"allowed_org_ids":[]}'::jsonb WHERE key='deposit_rule_hints'`);
  const pending = await createLease(session, {
    roomId: property.roomIds[1], tenantName: "B007 final signer", tenantPhone: "0912000333", tenantEmail: "b007-final@example.com", lineUserId: "", startDate: "2026-12-01", endDate: "2027-11-30", rentMajor: 100, depositMonths: 2, depositReason: "", dueDay: 5, splitMethod: "even", periodStart: "2026-12-01", periodEnd: "2026-12-31", billTotalMajor: null, usageKwh: null, rateMajor: null, rateSource: "bill_average", overrideReason: "", subUsages: [],
  });
  const party = (await query<{ org_id: string; contact_id: string }>(`SELECT l.org_id::text,lp.contact_id::text FROM leases l JOIN lease_parties lp ON lp.lease_id=l.id AND lp.role='primary' WHERE l.id=$1`, [pending.leaseId])).rows[0];
  const doc = (await query<{ id: string }>(`INSERT INTO identity_documents(org_id,contact_id,lease_id,doc_type,number_masked,storage_path,encryption_key_ref,review_status,created_by)
    VALUES ($1,$2,$3,'passport','A**789',$4,'fixture-key-ref','pending_review',$5) RETURNING id::text`,
    [party.org_id, party.contact_id, pending.leaseId, `${party.org_id}/${pending.leaseId}/fixture-doc`, USERS.admin])).rows[0].id;
  for (const slot of ["front", "selfie"]) {
    await query(`INSERT INTO identity_document_photos(org_id,document_id,slot,storage_path,mime_type,size_bytes,sha256)
      VALUES ($1,$2,$3,$4,'image/jpeg',4,'abc')`, [party.org_id, doc, slot, `${party.org_id}/${pending.leaseId}/${slot}`]);
  }
  const manager = await signLease(session, { leaseId: pending.leaseId, signedName: "Manager fixture", consent: true });
  assert.equal(manager.esign, "partially_signed");
  const tenant: Session = { ...session, sessionId:await withClient(c=>insertTestAuthSession(c,pending.tenantUserId)), kind: "tenant", role: null, userId: pending.tenantUserId, name: "Tenant fixture" };
  const signed = await signLease(tenant, { leaseId: pending.leaseId, signedName: "Tenant fixture", consent: true });
  assert.equal(signed.esign, "fully_signed");
  const active = await query<{ status: string }>(`SELECT status::text FROM leases WHERE id=$1`, [pending.leaseId]);
  assert.equal(active.rows[0]?.status, "active");
});

test("B007 writes serialize both orders of a global OFF change", async () => {
  const setup = new Client({ connectionString: url });
  const save = new Client({ connectionString: url });
  const config = new Client({ connectionString: url });
  await Promise.all([setup.connect(), save.connect(), config.connect()]);
  let saveOpen = false;
  let configOpen = false;
  try {
    const org = (await setup.query<{ id: string }>(`INSERT INTO organizations(name,country_code,default_currency,feature_flags)
      VALUES ('B007 race','US','USD','{"deposit_rule_hints":true}') RETURNING id::text`)).rows[0].id;
    await setup.query(`INSERT INTO org_members(org_id,user_id,role) VALUES ($1,$2,'admin')`, [org, USERS.admin]);
    const property = (await setup.query<{ id: string }>(`INSERT INTO properties(org_id,name,country_code,jurisdiction_id,currency,timezone,default_rental_mode)
      SELECT $1,'B007 race','US',id,'USD','UTC','whole_unit' FROM jurisdictions WHERE code='US' RETURNING id::text`, [org])).rows[0].id;
    const unit = (await setup.query<{ id: string }>(`INSERT INTO units(org_id,property_id,label,rental_mode)
      VALUES ($1,$2,'B007 race','whole_unit') RETURNING id::text`, [org, property])).rows[0].id;
    const enabled = JSON.stringify({ enabled: true, allowed_org_ids: [org] });
    const disabled = JSON.stringify({ enabled: false, allowed_org_ids: [org] });
    await setup.query(`UPDATE platform_settings SET value=$1::jsonb WHERE key='deposit_rule_hints'`, [enabled]);
    const beginSave = async () => {
      await save.query("BEGIN"); saveOpen = true;
      await save.query(`SELECT set_config('request.jwt.claim.sub',$1,true),set_config('request.jwt.claim.role','authenticated',true),
        set_config('app.active_org_id',$2,true),set_config('app.env','live',true)`, [USERS.admin, org]);
      await save.query("SET LOCAL ROLE authenticated");
    };
    const write = (months = 3) => save.query(`INSERT INTO leases(org_id,property_id,unit_id,target_unit_id,status,start_date,currency,rent_amount_minor,deposit_amount_minor,deposit_months)
      VALUES ($1,$2,$3,$3,'draft','2026-01-01','USD',10000,$4,$5)`, [org, property, unit, months * 10000, months]);
    // Save first: OFF must wait until the save transaction commits.
    await beginSave();
    await write();
    await config.query("BEGIN"); configOpen = true;
    const pid = (await config.query<{ pid: number }>(`SELECT pg_backend_pid() AS pid`)).rows[0].pid;
    const waiting = config.query(`UPDATE platform_settings SET value=$1::jsonb WHERE key='deposit_rule_hints'`, [disabled]);
    let blocked = false;
    for (let i = 0; i < 100; i += 1) {
      const row = await setup.query<{ blocked: boolean }>(`SELECT cardinality(pg_blocking_pids($1)) > 0 AS blocked`, [pid]);
      if (row.rows[0].blocked) { blocked = true; break; }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(blocked, true, "configuration update must wait for the save lock");
    await save.query("COMMIT"); saveOpen = false;
    await waiting;
    await config.query("COMMIT"); configOpen = false;
    // OFF first: an in-flight OFF transaction makes a concurrent save fail
    // immediately, and after commit the same forged write fails the legacy cap.
    await setup.query(`UPDATE platform_settings SET value=$1::jsonb WHERE key='deposit_rule_hints'`, [enabled]);
    await config.query("BEGIN"); configOpen = true;
    await config.query(`UPDATE platform_settings SET value=$1::jsonb WHERE key='deposit_rule_hints'`, [disabled]);
    await beginSave();
    await assert.rejects(write(), (error: unknown) => (error as { code?: string }).code === "55P03");
    await save.query("ROLLBACK"); saveOpen = false;
    await config.query("COMMIT"); configOpen = false;
    await beginSave();
    await assert.rejects(write(), (error: unknown) => (error as { code?: string }).code === "23514");
    await save.query("ROLLBACK"); saveOpen = false;

    // Org OFF first also fails a concurrent save before reading policy.
    await setup.query(`UPDATE platform_settings SET value=$1::jsonb WHERE key='deposit_rule_hints'`, [enabled]);
    await config.query("BEGIN"); configOpen = true;
    await config.query(`UPDATE organizations SET feature_flags=feature_flags || '{"deposit_rule_hints":false}'::jsonb WHERE id=$1`, [org]);
    await beginSave();
    await assert.rejects(write(), (error: unknown) => (error as { code?: string }).code === "55P03");
    await save.query("ROLLBACK"); saveOpen = false;
    await config.query("ROLLBACK"); configOpen = false;

    async function assertSettingWriterWaits(sql: string, params: unknown[], absent: boolean) {
      if (absent) {
        await setup.query(`DELETE FROM platform_settings WHERE key='deposit_rule_hints'`);
      } else {
        await setup.query(`INSERT INTO platform_settings(key,value) VALUES ('deposit_rule_hints',$1::jsonb)
          ON CONFLICT (key) DO UPDATE SET value=excluded.value`, [enabled]);
      }
      await beginSave();
      await write(absent ? 2 : 3);
      await config.query("BEGIN"); configOpen = true;
      const writerPid = (await config.query<{ pid: number }>(`SELECT pg_backend_pid() AS pid`)).rows[0].pid;
      const pending = config.query(sql, params);
      let isBlocked = false;
      for (let i = 0; i < 100; i += 1) {
        const row = await setup.query<{ blocked: boolean }>(`SELECT cardinality(pg_blocking_pids($1)) > 0 AS blocked`, [writerPid]);
        if (row.rows[0].blocked) { isBlocked = true; break; }
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      assert.equal(isBlocked, true, `setting mutation must wait: ${sql}`);
      await save.query("COMMIT"); saveOpen = false;
      await pending;
      await config.query("ROLLBACK"); configOpen = false;
    }
    await assertSettingWriterWaits(`DELETE FROM platform_settings WHERE key='deposit_rule_hints'`, [], false);
    await assertSettingWriterWaits(`UPDATE platform_settings SET key='b007_renamed' WHERE key='deposit_rule_hints'`, [], false);
    await assertSettingWriterWaits(`TRUNCATE platform_settings`, [], false);
    await assertSettingWriterWaits(`INSERT INTO platform_settings(key,value) VALUES ('deposit_rule_hints',$1::jsonb)`, [enabled], true);
    await setup.query(`INSERT INTO platform_settings(key,value) VALUES ('b007_other',$1::jsonb) ON CONFLICT (key) DO UPDATE SET value=excluded.value`, [enabled]);
    await assertSettingWriterWaits(`UPDATE platform_settings SET key='deposit_rule_hints' WHERE key='b007_other'`, [], true);
  } finally {
    if (saveOpen) await save.query("ROLLBACK").catch(() => {});
    if (configOpen) await config.query("ROLLBACK").catch(() => {});
    await Promise.all([setup.end(), save.end(), config.end()]);
  }
});
