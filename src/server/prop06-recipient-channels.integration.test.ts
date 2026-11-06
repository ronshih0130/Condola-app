import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { Client } from "pg";
import { ORG_ID, ORG2_ID, USERS } from "./ids";
import { cloneTestDatabase } from "./test-database-clone";
import { disposableDbUrl } from "./test-disposable-db";

disposableDbUrl(process.env.DATABASE_URL, process.env.CONDOLA_RLS_DISPOSABLE);
let clone: Awaited<ReturnType<typeof cloneTestDatabase>>, db: Client;
test.before(async () => { clone = await cloneTestDatabase(); db = new Client({ connectionString: clone.url }); await db.connect(); });
test.after(async () => { await db?.end(); await clone?.cleanup(); });

const code = (c: string) => (e: unknown) => (e as { code?: string }).code === c;
async function asStaff<T>(user: string, org: string | null, env: string | null, fn: () => Promise<T>): Promise<T> {
  await db.query("BEGIN");
  try {
    await db.query(`SELECT set_config('request.jwt.claim.sub',$1,true),set_config('app.active_org_id',$2,true),set_config('app.env',$3,true)`, [user, org ?? "", env ?? ""]);
    await db.query("SET LOCAL ROLE authenticated");
    const out = await fn(); await db.query("COMMIT"); return out;
  } catch (e) { await db.query("ROLLBACK"); throw e; }
}
const channels = (contact: string, org = ORG_ID, persona = "tenant") => db.query(`SELECT * FROM app.prop06_recipient_channels($1,$2,$3)`, [org, contact, persona]);

test("reports channel availability without addresses or LINE ids; LINE needs a live link", async () => {
  const user = randomUUID();
  await db.query(`INSERT INTO auth.users(id,email,role,aud) VALUES($1,$2,'authenticated','authenticated')`, [user, `${user}@example.invalid`]);
  const contact = (await db.query<{ id: string }>(`INSERT INTO contacts(org_id,is_tenant,display_name,email,user_id) VALUES($1,true,'P06','p06@example.invalid',$2) RETURNING id::text`, [ORG_ID, user])).rows[0].id;
  let r = (await asStaff(USERS.admin, ORG_ID, "live", () => channels(contact))).rows[0];
  assert.deepEqual(r, { portal: "tenant", email_available: true, in_app_available: true, line_bound: false, line_friend: false });
  assert.deepEqual(Object.keys(r).sort(), ["email_available", "in_app_available", "line_bound", "line_friend", "portal"]);
  await db.query(`UPDATE line_channels SET is_active=false WHERE org_id=$1 AND is_active`, [ORG_ID]);
  const ch = (await db.query<{ id: string }>(`INSERT INTO line_channels(org_id,mode,display_name,line_provider_id,messaging_channel_id,messaging_channel_secret_ref,messaging_access_token_ref) VALUES($1,'org_owned','P06','prov',$2,'ref:s','ref:t') RETURNING id::text`, [ORG_ID, `msg-${randomUUID()}`])).rows[0].id;
  // A friend link on some other (stale/unselected) OA never counts.
  const stale = (await db.query<{ id: string }>(`INSERT INTO line_channels(org_id,mode,display_name,line_provider_id,messaging_channel_id,messaging_channel_secret_ref,messaging_access_token_ref,is_active) VALUES($1,'org_owned','P06 old','prov',$2,'ref:s','ref:t',false) RETURNING id::text`, [ORG_ID, `old-${randomUUID()}`])).rows[0].id;
  await db.query(`INSERT INTO line_account_links(org_id,contact_id,line_channel_id,line_user_id,status,linked_at,is_friend) VALUES($1,$2,$3,$4,'linked',now(),true)`, [ORG_ID, contact, stale, "U" + "b".repeat(32)]);
  await db.query(`UPDATE organizations SET line_channel_id=$2 WHERE id=$1`, [ORG_ID, ch]);
  r = (await asStaff(USERS.admin, ORG_ID, "live", () => channels(contact))).rows[0];
  assert.deepEqual([r.line_bound, r.line_friend], [false, false], "link on an unselected OA does not count");
  await db.query(`INSERT INTO line_account_links(org_id,contact_id,line_channel_id,line_user_id,status,linked_at,is_friend) VALUES($1,$2,$3,$4,'linked',now(),false)`, [ORG_ID, contact, ch, "U" + "a".repeat(32)]);
  r = (await asStaff(USERS.admin, ORG_ID, "live", () => channels(contact))).rows[0];
  assert.deepEqual([r.line_bound, r.line_friend], [true, false]);
  await db.query(`UPDATE line_account_links SET is_friend=true WHERE contact_id=$1`, [contact]);
  r = (await asStaff(USERS.admin, ORG_ID, "live", () => channels(contact))).rows[0];
  assert.deepEqual([r.line_bound, r.line_friend], [true, true]);
  await db.query(`UPDATE line_account_links SET status='unlinked',unlinked_at=now() WHERE contact_id=$1`, [contact]);
  r = (await asStaff(USERS.admin, ORG_ID, "live", () => channels(contact))).rows[0];
  assert.deepEqual([r.line_bound, r.line_friend], [false, false]);
});

test("requires an exact org/env pin and membership; other orgs and API roles are denied", async () => {
  const contact = (await db.query<{ id: string }>(`INSERT INTO contacts(org_id,is_owner,display_name) VALUES($1,true,'P06 owner') RETURNING id::text`, [ORG_ID])).rows[0].id;
  for (const [org, env] of [[null, null], [ORG_ID, null], [ORG_ID, "sandbox"], [ORG2_ID, "live"]] as const)
    await assert.rejects(asStaff(USERS.admin, org, env, () => channels(contact)), code("42501"));
  await assert.rejects(asStaff(USERS.coastAdmin, ORG_ID, "live", () => channels(contact)), code("42501"));
  assert.deepEqual((await asStaff(USERS.coastAdmin, ORG2_ID, "live", () => channels(contact, ORG2_ID))).rows, []);
  const r = (await asStaff(USERS.admin, ORG_ID, "live", () => channels(contact, ORG_ID, "owner"))).rows[0];
  assert.deepEqual(r, { portal: "owner", email_available: false, in_app_available: false, line_bound: false, line_friend: false });
  for (const role of ["anon", "service_role"])
    assert.equal((await db.query(`SELECT has_function_privilege($1,'app.prop06_recipient_channels(uuid,uuid,text)','EXECUTE') a`, [role])).rows[0].a, false);
});

test("persona is explicit and validated against the contact's roles (multi-role contacts)", async () => {
  const both = (await db.query<{ id: string }>(`INSERT INTO contacts(org_id,is_tenant,is_owner,display_name) VALUES($1,true,true,'P06 both') RETURNING id::text`, [ORG_ID])).rows[0].id;
  assert.equal((await asStaff(USERS.admin, ORG_ID, "live", () => channels(both, ORG_ID, "owner"))).rows[0].portal, "owner");
  assert.equal((await asStaff(USERS.admin, ORG_ID, "live", () => channels(both, ORG_ID, "tenant"))).rows[0].portal, "tenant");
  assert.equal((await asStaff(USERS.admin, ORG_ID, "live", () => channels(both, ORG_ID, "vendor"))).rows[0].portal, null);
  await assert.rejects(asStaff(USERS.admin, ORG_ID, "live", () => channels(both, ORG_ID, "staff")), code("22023"));
});

test("sandbox: parent-org staff with a sandbox pin can read; live pin or unrelated staff cannot", async () => {
  const sandbox = (await db.query<{ id: string }>(`SELECT id::text FROM organizations WHERE environment='sandbox' AND live_org_id=$1`, [ORG_ID])).rows[0]?.id
    ?? (await db.query<{ id: string }>(`INSERT INTO organizations(name,country_code,default_currency,environment,live_org_id) VALUES($1,'TW','TWD','sandbox',$2) RETURNING id::text`, [randomUUID(), ORG_ID])).rows[0].id;
  const c = (await db.query<{ id: string }>(`INSERT INTO contacts(org_id,is_tenant,display_name) VALUES($1,true,'P06 sandbox') RETURNING id::text`, [sandbox])).rows[0].id;
  assert.equal((await asStaff(USERS.admin, sandbox, "sandbox", () => channels(c, sandbox))).rows[0].portal, "tenant");
  await assert.rejects(asStaff(USERS.admin, sandbox, "live", () => channels(c, sandbox)), code("42501"));
  await assert.rejects(asStaff(USERS.admin, ORG_ID, "live", () => channels(c, sandbox)), code("42501"));
  await assert.rejects(asStaff(USERS.coastAdmin, sandbox, "sandbox", () => channels(c, sandbox)), code("42501"));
  const live = (await db.query<{ id: string }>(`INSERT INTO contacts(org_id,is_tenant,display_name) VALUES($1,true,'P06 live') RETURNING id::text`, [ORG_ID])).rows[0].id;
  await assert.rejects(asStaff(USERS.admin, sandbox, "sandbox", () => channels(live, ORG_ID)), code("42501"));
});

