import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { Client } from "pg";
import { USERS } from "./ids";
import { disposableDbUrl } from "./test-disposable-db";

disposableDbUrl(process.env.DATABASE_URL, process.env.CONDOLA_RLS_DISPOSABLE);

test("audited payee gateway keeps disclosure, denial and isolation in one durable decision", async () => {
  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  const org = randomUUID(), sandbox = randomUUID(), property = randomUUID(), unit = randomUUID(), lease = randomUUID();
  const contact = randomUUID(), adminSession = randomUUID(), tenantSession = randomUUID(), expiredSession = randomUUID();
  const managerSession = randomUUID(), accountantSession = randomUUID();
  const attempts: string[] = [];
  const flagBefore = (await client.query(`SELECT value FROM platform_settings WHERE key='payee_details'`)).rows[0].value;
  async function invoke(op: string, session: string | null, actor: string | null, orgId: string | null, env: string | null, id: string | null = null, input: object = {}) {
    const attempt = randomUUID(); attempts.push(attempt);
    await client.query("BEGIN");
    try {
      await client.query("SET LOCAL ROLE service_role");
      const result = await client.query(`SELECT app.payee_gateway($1,$2,$3,$4,$5,$6,$7,$8::jsonb) AS value`,
        [session, actor, orgId, env, attempt, op, id, JSON.stringify(input)]);
      await client.query("COMMIT");
      return { attempt, value: result.rows[0].value };
    } catch (error) { await client.query("ROLLBACK"); throw error; }
  }
  try {
    await client.query(`INSERT INTO organizations(id,name,country_code,default_currency,environment,feature_flags) VALUES ($1,'Synthetic payee','TW','TWD','live','{}')`, [org]);
    await client.query(`INSERT INTO organizations(id,name,country_code,default_currency,environment,live_org_id,feature_flags) VALUES ($1,'Synthetic payee sandbox','TW','TWD','sandbox',$2,'{}')`, [sandbox, org]);
    await client.query(`INSERT INTO org_members(org_id,user_id,role,status) VALUES ($1,$2,'admin','active')`, [org, USERS.admin]);
    await client.query(`INSERT INTO org_members(org_id,user_id,role,status) VALUES ($1,$2,'manager','active'),($1,$3,'accountant','active')`, [org, USERS.manager, USERS.accountant]);
    await client.query(`INSERT INTO contacts(id,org_id,user_id,is_tenant,display_name) VALUES ($1,$2,$3,true,'Synthetic tenant')`, [contact, org, USERS.tenant]);
    await client.query(`INSERT INTO properties(id,org_id,name,country_code,currency,timezone) VALUES ($1,$2,'Synthetic','TW','TWD','Asia/Taipei')`, [property, org]);
    await client.query(`INSERT INTO units(id,org_id,property_id,label) VALUES ($1,$2,$3,'Synthetic')`, [unit, org, property]);
    await client.query(`INSERT INTO leases(id,org_id,property_id,unit_id,target_unit_id,status,start_date,end_date,currency,rent_amount_minor)
      VALUES ($1,$2,$3,$4,$4,'active',current_date-1,current_date+365,'TWD',0)`, [lease, org, property, unit]);
    await client.query(`INSERT INTO lease_parties(org_id,lease_id,contact_id) VALUES ($1,$2,$3)`, [org, lease, contact]);
    for (const [id, user, expired] of [[adminSession, USERS.admin, false], [tenantSession, USERS.tenant, false], [expiredSession, USERS.tenant, true], [managerSession, USERS.manager, false], [accountantSession, USERS.accountant, false]] as const) {
      await client.query(`INSERT INTO auth_sessions(id,user_id,token_hash,expires_at) VALUES ($1,$2,$3,now()+($4::int * interval '1 day'))`, [id, user, randomUUID(), expired ? -1 : 1]);
    }
    const off = await invoke("tenant", tenantSession, USERS.tenant, org, "live", lease);
    assert.equal(off.value.ok, true); assert.equal(off.value.data.enabled, false);
    assert.equal(off.value.data.account, null);
    const unauth = await invoke("ingress", null, null, null, null);
    assert.equal(unauth.value.reason, "unauthenticated");
    const noOrg = await invoke("ingress", tenantSession, USERS.tenant, null, null);
    assert.equal(noOrg.value.reason, "no_context");
    const expired = await invoke("tenant", expiredSession, USERS.tenant, org, "live", lease);
    assert.equal(expired.value.reason, "unauthenticated");
    await client.query(`UPDATE organizations SET feature_flags=jsonb_set(feature_flags,'{payee_details}','true') WHERE id=$1`, [org]);
    await client.query(`UPDATE organizations SET feature_flags=jsonb_set(feature_flags,'{payee_details}','true') WHERE id=$1`, [sandbox]);
    await client.query(`UPDATE platform_settings SET value=jsonb_build_object('enabled',true,'allowed_org_ids',jsonb_build_array($1::text,$2::text)) WHERE key='payee_details'`, [org, sandbox]);
    // The sandbox clone has no member yet, but a newly promoted live admin is authorized.
    await client.query(`UPDATE org_members SET role='admin' WHERE org_id=$1 AND user_id=$2`, [org, USERS.manager]);
    assert.equal((await invoke("settings", managerSession, USERS.manager, sandbox, "sandbox")).value.ok, true);
    await client.query(`INSERT INTO org_members(org_id,user_id,role,status) VALUES ($1,$2,'admin','active')`, [sandbox, USERS.manager]);
    await client.query(`UPDATE org_members SET role='manager' WHERE org_id=$1 AND user_id=$2`, [org, USERS.manager]);
    // A stale sandbox admin membership cannot override the demoted live role.
    assert.equal((await invoke("settings", managerSession, USERS.manager, sandbox, "sandbox")).value.ok, false);
    const fields = { holderName: "Synthetic Holder", bankName: "Example", bankCode: "123", branchCode: "456", accountNumber: "1234509876", ownerContactId: null, isDefault: true, details: {} };
    const saved = await invoke("save", adminSession, USERS.admin, org, "live", null, fields);
    assert.equal(saved.value.ok, true);
    const accountId = saved.value.data.accountId;
    for (const [session, actor] of [[managerSession, USERS.manager], [accountantSession, USERS.accountant], [tenantSession, USERS.tenant]] as const) {
      assert.equal((await invoke("settings", session, actor, org, "live")).value.ok, false);
      assert.equal((await invoke("save", session, actor, org, "live", accountId, fields)).value.ok, false);
      assert.equal((await invoke("assign", session, actor, org, "live", lease, { accountId })).value.ok, false);
    }
    assert.equal((await invoke("settings", tenantSession, USERS.admin, org, "live")).value.reason, "unauthenticated");
    const read = await invoke("tenant", tenantSession, USERS.tenant, org, "live", lease);
    assert.equal(read.value.ok, true); assert.equal(read.value.data.account.account_number, fields.accountNumber);
    await client.query(`UPDATE leases SET start_date=current_date+1 WHERE id=$1`, [lease]);
    const future = await invoke("tenant", tenantSession, USERS.tenant, org, "live", lease);
    assert.equal(future.value.reason, "forbidden"); assert.equal(future.value.data, null);
    await client.query(`UPDATE leases SET start_date=current_date-1,status='pending_signature' WHERE id=$1`, [lease]);
    const pending = await invoke("tenant", tenantSession, USERS.tenant, org, "live", lease);
    assert.equal(pending.value.reason, "forbidden"); assert.equal(pending.value.data, null);
    await client.query(`UPDATE leases SET status='active' WHERE id=$1`, [lease]);
    const ownerId = randomUUID();
    await client.query(`INSERT INTO contacts(id,org_id,is_owner,display_name) VALUES ($1,$2,true,'Synthetic owner')`, [ownerId, org]);
    const ownerSave = await invoke("save", adminSession, USERS.admin, org, "live", null,
      { ...fields, holderName: "Synthetic Owner", accountNumber: "6543204567", ownerContactId: ownerId, isDefault: false });
    assert.equal(ownerSave.value.ok, true);
    assert.equal((await invoke("assign", adminSession, USERS.admin, org, "live", lease, { accountId: ownerSave.value.data.accountId })).value.ok, true);
    const ownerRead = await invoke("tenant", tenantSession, USERS.tenant, org, "live", lease);
    assert.equal(ownerRead.value.data.account.owner_contact_id, "owner");
    assert.equal(ownerRead.value.data.account.account_number, "6543204567");
    assert.equal((await invoke("assign", adminSession, USERS.admin, org, "live", lease, { accountId: null })).value.ok, true);
    const wrongEnv = await invoke("tenant", tenantSession, USERS.tenant, sandbox, "sandbox", lease);
    assert.equal(wrongEnv.value.ok, false); assert.equal(wrongEnv.value.data, null);
    const missing = await invoke("tenant", tenantSession, USERS.tenant, org, "live", randomUUID());
    assert.equal(missing.value.ok, false);
    const invalid = await invoke("assign", adminSession, USERS.admin, org, "live", lease, { accountId: "bad", invalid: true });
    assert.equal(invalid.value.ok, false);
    const assigned = await invoke("assign", adminSession, USERS.admin, org, "live", lease, { accountId });
    assert.equal(assigned.value.ok, true);
    const otherProperty = randomUUID(), otherPropertyAccount = randomUUID();
    await client.query(`INSERT INTO properties(id,org_id,name,country_code,currency,timezone) VALUES ($1,$2,'Other synthetic','TW','TWD','Asia/Taipei')`, [otherProperty, org]);
    await client.query(`INSERT INTO bank_accounts(id,org_id,property_id,nickname,currency) VALUES ($1,$2,$3,'Other property account','TWD')`, [otherPropertyAccount, org, otherProperty]);
    const wrongProperty = await invoke("assign", adminSession, USERS.admin, org, "live", lease, { accountId: otherPropertyAccount });
    assert.equal(wrongProperty.value.ok, false);
    assert.equal((await client.query(`SELECT payee_bank_account_id::text AS id FROM leases WHERE id=$1`, [lease])).rows[0].id, accountId);
    // Existing assignment is rechecked if privileged historical data changes.
    await client.query(`UPDATE bank_accounts SET property_id=$1 WHERE id=$2`, [property, accountId]);
    assert.equal((await invoke("tenant", tenantSession, USERS.tenant, org, "live", lease)).value.data.account.account_number, fields.accountNumber);
    await client.query(`UPDATE bank_accounts SET property_id=$1 WHERE id=$2`, [otherProperty, accountId]);
    assert.equal((await invoke("tenant", tenantSession, USERS.tenant, org, "live", lease)).value.data.account, null);
    await client.query(`UPDATE bank_accounts SET property_id=NULL WHERE id=$1`, [accountId]);
    const foreignAccount = randomUUID();
    await client.query(`INSERT INTO bank_accounts(id,org_id,nickname,currency) VALUES ($1,$2,'Synthetic foreign','TWD')`, [foreignAccount, sandbox]);
    const crossAssign = await invoke("assign", adminSession, USERS.admin, org, "live", lease, { accountId: foreignAccount });
    assert.equal(crossAssign.value.ok, false);
    assert.equal((await client.query(`SELECT payee_bank_account_id::text AS id FROM leases WHERE id=$1`, [lease])).rows[0].id, accountId);
    // A broken explicit assignment must not fall back to the company default.
    await client.query(`UPDATE bank_accounts SET archived_at=now() WHERE id=$1`, [accountId]);
    const unavailable = await invoke("tenant", tenantSession, USERS.tenant, org, "live", lease);
    assert.equal(unavailable.value.ok, true);
    assert.equal(unavailable.value.data.account, null);
    await client.query(`UPDATE bank_accounts SET archived_at=NULL WHERE id=$1`, [accountId]);
    await client.query("BEGIN");
    await client.query("SET LOCAL ROLE authenticated");
    await client.query(`SELECT set_config('request.jwt.claim.sub',$1,true),set_config('app.active_org_id',$2,true),set_config('app.env','live',true)`, [USERS.admin, org]);
    await assert.rejects(client.query(`UPDATE bank_accounts SET show_to_tenants=false WHERE id=$1`, [accountId]), /payee|permission denied/i);
    await client.query("ROLLBACK");
    await client.query("BEGIN");
    await client.query("SET LOCAL ROLE service_role");
    await assert.rejects(client.query(`UPDATE bank_accounts SET bank_name='changed' WHERE id=$1`, [accountId]), /payee|permission denied/i);
    await client.query("ROLLBACK");
    await client.query("BEGIN");
    await client.query("SET LOCAL ROLE authenticated");
    await client.query(`SELECT set_config('request.jwt.claim.sub',$1,true),set_config('app.active_org_id',$2,true),set_config('app.env','live',true)`, [USERS.admin, org]);
    const legacyId = randomUUID();
    await client.query(`INSERT INTO bank_accounts(id,org_id,nickname,currency) VALUES ($1,$2,'Synthetic legacy','TWD')`, [legacyId, org]);
    await client.query(`UPDATE bank_accounts SET nickname='Synthetic legacy edit' WHERE id=$1`, [legacyId]);
    await client.query("COMMIT");
    const assignLegacy = await invoke("assign", adminSession, USERS.admin, org, "live", lease, { accountId: legacyId });
    assert.equal(assignLegacy.value.ok, true);
    await client.query("BEGIN");
    await client.query("SET LOCAL ROLE authenticated");
    await client.query(`SELECT set_config('request.jwt.claim.sub',$1,true),set_config('app.active_org_id',$2,true),set_config('app.env','live',true)`, [USERS.admin, org]);
    await assert.rejects(client.query(`UPDATE bank_accounts SET nickname='changed' WHERE id=$1`, [legacyId]), /payee|permission denied/i);
    await client.query("ROLLBACK");
    assert.equal((await invoke("assign", adminSession, USERS.admin, org, "live", lease, { accountId })).value.ok, true);

    // Two independent sessions race to set a company default; both operations
    // are audited and the database keeps exactly one default.
    async function parallelSave(suffix: string) {
      const c = new Client({ connectionString: process.env.DATABASE_URL });
      await c.connect();
      const attempt = randomUUID(); attempts.push(attempt);
      try {
        await c.query("BEGIN"); await c.query("SET LOCAL ROLE service_role");
        const result = await c.query(`SELECT app.payee_gateway($1,$2,$3,'live',$4,'save',NULL,$5::jsonb) AS value`,
          [adminSession, USERS.admin, org, attempt, JSON.stringify({ ...fields, accountNumber: `238491${suffix}` })]);
        await c.query("COMMIT");
        return result.rows[0].value;
      } catch (error) { await c.query("ROLLBACK"); throw error; }
      finally { await c.end(); }
    }
    const concurrent = await Promise.all([parallelSave("1111"), parallelSave("2222")]);
    assert.ok(concurrent.every((result) => result.ok));
    assert.equal((await client.query(`SELECT count(*)::int AS n FROM bank_accounts WHERE org_id=$1 AND is_default_payee AND archived_at IS NULL`, [org])).rows[0].n, 1);
    const logs = await client.query(`SELECT attempt_id::text,actor_id::text,org_id::text,outcome,reason,account_last5 FROM app.payee_access_log WHERE attempt_id=ANY($1::uuid[])`, [attempts]);
    for (const id of attempts) assert.ok(logs.rows.some((row) => row.attempt_id === id));
    assert.equal(logs.rows.find((row) => row.attempt_id === noOrg.attempt)?.org_id, null);
    assert.equal(logs.rows.find((row) => row.attempt_id === noOrg.attempt)?.actor_id, USERS.tenant);
    assert.equal(logs.rows.find((row) => row.attempt_id === read.attempt)?.account_last5, "09876");
    assert.doesNotMatch(JSON.stringify(logs.rows), new RegExp(fields.accountNumber));
    const generalAudit = await client.query(`SELECT old_row,new_row,reason FROM audit_log WHERE org_id=$1`, [org]);
    assert.doesNotMatch(JSON.stringify(generalAudit.rows), /1234509876|6543204567|2384911111|2384912222/);
    for (const role of ["anon", "authenticated", "service_role"]) {
      const privileges = await client.query(`SELECT has_table_privilege($1,'public.payee_account_numbers','SELECT') AS n,
        has_function_privilege($1,'public.tenant_payee_account(uuid)','EXECUTE') AS f`, [role]);
      assert.deepEqual(privileges.rows[0], { n: false, f: false });
    }
    // Every disclosure depends on its log insert: if the log fails, the
    // gateway must fail without returning account data.
    await client.query(`CREATE FUNCTION app.payee_test_fail() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'synthetic audit failure'; END $$`);
    await client.query(`CREATE TRIGGER payee_test_fail BEFORE INSERT ON app.payee_access_log FOR EACH ROW EXECUTE FUNCTION app.payee_test_fail()`);
    try {
      await assert.rejects(invoke("tenant", tenantSession, USERS.tenant, org, "live", lease), /synthetic audit failure/);
    } finally {
      await client.query(`DROP TRIGGER payee_test_fail ON app.payee_access_log`);
      await client.query(`DROP FUNCTION app.payee_test_fail()`);
    }
  } finally {
    await client.query(`UPDATE platform_settings SET value=$1::jsonb WHERE key='payee_details'`, [JSON.stringify(flagBefore)]);
    await client.end();
  }
});
