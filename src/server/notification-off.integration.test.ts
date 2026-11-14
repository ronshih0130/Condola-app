import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import test from "node:test";
import ts from "typescript";
import { Client } from "pg";
import { cloneTestDatabase } from "./test-database-clone";
import { disposableDbUrl } from "./test-disposable-db";
import { ORG_ID, ORG2_ID, USERS } from "./ids";
import * as center from "./notification-center";
import { hashVendorToken, newVendorToken } from "./vendor-repair-rules";
import { resetAndSeed } from "./seed";
import type { Session } from "./types";

disposableDbUrl(process.env.DATABASE_URL, process.env.CONDOLA_RLS_DISPOSABLE);
let clone: Awaited<ReturnType<typeof cloneTestDatabase>> | undefined;
test.before(async () => {
  clone = await cloneTestDatabase();
  const demo = process.env.DEMO_MODE, key = process.env.ID_DOC_ENCRYPTION_KEY;
  try {
    process.env.DEMO_MODE = "true";
    process.env.ID_DOC_ENCRYPTION_KEY = randomBytes(32).toString("hex");
    await resetAndSeed();
  } finally {
    if (demo === undefined) delete process.env.DEMO_MODE; else process.env.DEMO_MODE = demo;
    if (key === undefined) delete process.env.ID_DOC_ENCRYPTION_KEY; else process.env.ID_DOC_ENCRYPTION_KEY = key;
  }
});
test.after(async () => { await clone?.cleanup(); });

// Execute the actual TSX entry/route functions. Only the Next request context
// and presentation dependencies are supplied here; every admission/read/mark
// call below uses the real server gateway and a real local PostgreSQL client.
// This is server-component integration evidence, not browser/HTTP evidence.
const requireLocal = createRequire(import.meta.url);
function view<T>(path: string, session: Session): T {
  const source = readFileSync(new URL(path, import.meta.url), "utf8");
  const output = ts.transpileModule(source, {compilerOptions: {
    module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2022,
  }}).outputText;
  const dependencies: Record<string, unknown> = {
    "@/server/notification-center": center,
    "@/server/session": {getSession: async () => session, requestPrefs: async () => ({locale:"en"})},
    "@/server/consent-gate": {requireCurrentConsent: async () => {}},
    "@/server/repair-rules": requireLocal("./repair-rules"),
    "@/i18n/lanes/notification-center": requireLocal("../i18n/lanes/notification-center"),
    "@/components/notification-center": {NotificationCenter: () => null, NotificationCenterBusy: () => null},
    // B-046: presentation only; passed as the `empty` slot after admission and the item read.
    "@/components/management-empty-state": {ManagementEmptyState: () => null},
    "next/link": {default: () => null},
    "next/navigation": {notFound: () => { throw Object.assign(new Error("Not found"), {digest:"NEXT_HTTP_ERROR_FALLBACK;404"}); }},
    "react/jsx-runtime": requireLocal("react/jsx-runtime"),
  };
  const exports = {};
  new Function("require", "exports", output)((name: string) => {
    assert.ok(Object.hasOwn(dependencies, name), `Unexpected view dependency: ${name}`);
    return dependencies[name];
  }, exports);
  return exports as T;
}

test("four portals fail closed for every OFF control without changing domain rows", async t => {
  const c = new Client({connectionString:process.env.DATABASE_URL}); await c.connect();
  try {
    const lease = (await c.query<{lease_id:string;tenant_id:string;tenant_user:string;owner_id:string;owner_user:string;property_id:string}>(`SELECT
      l.id::text lease_id,ct.id::text tenant_id,ct.user_id::text tenant_user,oc.id::text owner_id,oc.user_id::text owner_user,l.property_id::text
      FROM leases l JOIN lease_parties lp ON lp.lease_id=l.id AND lp.role='primary' JOIN contacts ct ON ct.id=lp.contact_id
      JOIN property_owners po ON po.property_id=l.property_id JOIN contacts oc ON oc.id=po.owner_contact_id
      WHERE l.org_id=$1 AND ct.user_id IS NOT NULL AND oc.user_id IS NOT NULL LIMIT 1`, [ORG_ID])).rows[0];
    assert.ok(lease);
    async function session(userId:string, kind:Session["kind"], role:Session["role"]): Promise<Session> {
      const sessionId = randomUUID();
      await c.query(`INSERT INTO auth_sessions(id,user_id,token_hash,expires_at) VALUES($1,$2,$3,clock_timestamp()+interval '1 hour')`, [sessionId,userId,randomUUID()]);
      return {userId,sessionId,kind,role,orgId:ORG_ID,liveOrgId:ORG_ID,environment:"live",locale:"en",calendar:"gregorian",leaseId:null,email:"synthetic@example.test",name:"Synthetic"};
    }
    const staff = await session(USERS.manager,"staff","manager");
    const tenant = await session(lease.tenant_user,"tenant",null);
    const owner = await session(lease.owner_user,"owner",null);
    const member = (await c.query<{id:string}>(`SELECT id::text FROM org_members WHERE org_id=$1 AND user_id=$2 AND status='active'`, [ORG_ID,staff.userId])).rows[0].id;
    await c.query(`UPDATE organizations SET plan_tier='beta',feature_flags=feature_flags || '{"notification_center_v2":true,"vendor_link":false}' WHERE id=$1`, [ORG_ID]);
    const vendor = (await c.query<{id:string}>(`INSERT INTO contacts(org_id,is_vendor,display_name,phone_e164) VALUES($1,true,'Synthetic OFF vendor','+886900111222') RETURNING id::text`, [ORG_ID])).rows[0].id;
    const ticket = (await c.query<{id:string}>(`INSERT INTO maintenance_tickets(org_id,ticket_number,property_id,lease_id,title,status,reported_by_user,reported_by_contact_id,assigned_vendor_contact_id)
      VALUES($1,987655,$2,$3,'Synthetic OFF','open',$4,$5,$6) RETURNING id::text`, [ORG_ID,lease.property_id,lease.lease_id,lease.tenant_user,lease.tenant_id,vendor])).rows[0].id;
    const token = newVendorToken();
    const job = (await c.query<{id:string;created_at:string}>(`INSERT INTO repair_vendor_jobs(org_id,ticket_id,vendor_name,vendor_phone,contact_window,token_hash,expires_at,vendor_contact_id)
      VALUES($1,$2,'Synthetic','+886900111222','day',$3,clock_timestamp()+interval '1 hour',$4) RETURNING id::text,created_at::text`, [ORG_ID,ticket,hashVendorToken(token),vendor])).rows[0];
    await c.query("BEGIN");
    const event = (await c.query<{id:string}>(`INSERT INTO app.b028_center_events(org_id,kind,ticket_id,job_id,occurred_at)
      VALUES($1,'vendor_job_assigned',$2,$3,$4) RETURNING id::text`, [ORG_ID,ticket,job.id,job.created_at])).rows[0].id;
    await c.query(`INSERT INTO app.b028_center_recipients(org_id,event_id,persona,principal_user_id,member_id,contact_id,ticket_id,job_id) VALUES
      ($1,$2,'staff',$3,$4,NULL,NULL,NULL),($1,$2,'tenant',$5,NULL,$6,NULL,NULL),
      ($1,$2,'owner',$7,NULL,$8,NULL,NULL),($1,$2,'vendor_job',NULL,NULL,NULL,$9,$10)`,
    [ORG_ID,event,staff.userId,member,tenant.userId,lease.tenant_id,owner.userId,lease.owner_id,ticket,job.id]);
    await c.query("COMMIT");
    const entry = view<{
      NotificationCenterEntry: (props:{session:Session}) => Promise<unknown>;
      VendorNotificationCenterEntry: (props:{token:string;locale:string}) => Promise<unknown>;
    }>("../components/notification-center-entry.tsx",staff);
    const portals = [staff,tenant,owner].map(s => {
      const portal = s.kind === "staff" ? "m" : s.kind === "tenant" ? "t" : "o";
      const page = view<{default: (props:{searchParams:Promise<object>}) => Promise<unknown>}>(`../app/${portal}/notifications/page.tsx`,s);
      return {name:portal, entry:() => entry.NotificationCenterEntry({session:s}), route:() => page.default({searchParams:Promise.resolve({})}),
        admission:() => center.centerSessionAdmission(s), items:(mark:string|null=null) => center.centerSessionItems(s,mark)};
    });
    const vendorPage = view<{default: (props:{params:Promise<{token:string}>;searchParams:Promise<object>}) => Promise<unknown>}>("../app/v/[token]/notifications/page.tsx",staff);
    portals.push({name:"v",entry:() => entry.VendorNotificationCenterEntry({token,locale:"en"}),
      route:() => vendorPage.default({params:Promise.resolve({token}),searchParams:Promise.resolve({})}),
      admission:() => center.centerVendorAdmission(token),items:(mark:string|null=null) => center.centerVendorItems(token,mark)});
    const globalOn = {enabled:true,allowed_org_ids:[ORG_ID]};
    const configure = async (value:unknown, orgEnabled=true) => {
      await c.query(`DELETE FROM platform_settings WHERE key='notification_center_v2'`);
      if (value !== undefined) await c.query(`INSERT INTO platform_settings(key,value) VALUES('notification_center_v2',$1::jsonb)`, [JSON.stringify(value)]);
      await c.query(`UPDATE organizations SET feature_flags=feature_flags || jsonb_build_object('notification_center_v2',$2::boolean) WHERE id=$1`, [ORG_ID,orgEnabled]);
    };
    // Positive controls rule out invalid sessions/job grants, missing recipients,
    // or a stubbed UI that would hide/404 even with valid ON configuration.
    await configure(globalOn);
    const recipients = new Map<string,string>();
    for (const portal of portals) {
      assert.equal(await portal.admission(),"enabled",portal.name);
      assert.ok(await portal.entry(),portal.name);
      assert.ok(await portal.route(),portal.name);
      const items = (await portal.items()).items;
      assert.equal(items.length,1,portal.name); assert.equal(items[0].read_at,null);
      recipients.set(portal.name,items[0].recipient_id);
    }
    // Full rows, across all application tables and all organizations, capture
    // financial/repair outcomes as well as read markers, cursors and contexts.
    const tables = (await c.query<{schema:string;name:string}>(`SELECT schemaname AS schema,tablename AS name FROM pg_tables
      WHERE schemaname IN ('public','app') ORDER BY schemaname,tablename`)).rows;
    async function snapshot() {
      const result: Record<string,unknown> = {};
      for (const {schema,name} of tables) {
        const quoted = [schema,name].map(s => '"' + s.replaceAll('"','""') + '"').join('.');
        result[`${schema}.${name}`] = (await c.query(`SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY to_jsonb(t)::text),'[]'::jsonb) AS rows FROM ${quoted} t`)).rows[0].rows;
      }
      return result;
    }
    const matrix = [
      {name:"absent global",value:undefined},
      {name:"false global",value:{...globalOn,enabled:false}},
      {name:"malformed global enabled",value:{...globalOn,enabled:"true"}},
      {name:"malformed global allowlist",value:{enabled:true,allowed_org_ids:ORG_ID}},
      {name:"missing allowlist membership",value:{enabled:true,allowed_org_ids:[ORG2_ID]}},
      {name:"false org control",value:globalOn,orgEnabled:false},
    ];
    for (const control of matrix) {
      await configure(control.value,control.orgEnabled ?? true);
      for (const portal of portals) {
        await t.test(`${portal.name}: ${control.name}`,async () => {
          const before = await snapshot();
          assert.equal(await portal.admission(),"disabled");
          assert.equal(await portal.entry(),null,"entry must be hidden");
          await assert.rejects(portal.route(),(error:unknown) => (error as {digest?:string}).digest === "NEXT_HTTP_ERROR_FALLBACK;404");
          assert.deepEqual(await portal.items(),{items:[],continuation:null});
          assert.deepEqual(await portal.items(recipients.get(portal.name)!),{items:[],continuation:null});
          assert.equal((await c.query(`SELECT 1 FROM app.b028_center_reads WHERE org_id=$1 AND recipient_id=$2`,[ORG_ID,recipients.get(portal.name)])).rowCount,0);
          const after = await snapshot();
          for (const table of Object.keys(before)) assert.deepEqual(after[table],before[table],`${portal.name}/${control.name}: ${table} changed`);
        });
      }
    }
    // The same retained recipient becomes markable when the synthetic control
    // is re-enabled. OFF did not delete or complete the pending notification.
    await configure(globalOn);
    for (const portal of portals) {
      const result = await portal.items(recipients.get(portal.name)!);
      assert.equal(result.items.length,1); assert.ok(result.items[0].read_at);
    }
  } finally { await c.query("ROLLBACK"); await c.end(); }
});
