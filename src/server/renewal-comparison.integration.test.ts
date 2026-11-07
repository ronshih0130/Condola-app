import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { Client } from "pg";
import { cloneTestDatabase } from "./test-database-clone";
import { disposableDbUrl } from "./test-disposable-db";
import { ORG_ID, USERS } from "./ids";
import type { Session } from "./types";
import { compareRenewal,renewalComparisonView } from "./renewal-comparison";
import { renewalMajor } from "@/lib/renewal-comparison";
import type { RenewalInput } from "@/lib/renewal-comparison";
import nextHeaders from "next/headers";
import { SESSION_COOKIE } from "./auth";
import { sessionTokenHash } from "./session";
import { leaseDetail } from "./queries";
import { compareRenewalAction } from "./renewal-comparison-actions";
import RenewalPage from "@/app/m/leases/[id]/renewal/page";
import { RenewalComparisonEntry } from "@/components/renewal-comparison-entry";
import { renewalCopy } from "@/i18n/renewal";

disposableDbUrl(process.env.DATABASE_URL,process.env.CONDOLA_RLS_DISPOSABLE);
let clone:Awaited<ReturnType<typeof cloneTestDatabase>>;
test.before(async()=>{clone=await cloneTestDatabase();});test.after(async()=>{await clone.cleanup();});

// Restore the complete control values after every test, including older tests.
// JSON text retains PostgreSQL timestamp precision (JS Date would lose micros).
async function readControls(c: Client) {
  return {
    global: (await c.query<{ row: string }>(`SELECT to_jsonb(p)::text AS row FROM platform_settings p WHERE key='lease_renewal'`)).rows[0]?.row ?? null,
    org: (await c.query<{ flags: string }>(`SELECT feature_flags::text AS flags FROM organizations WHERE id=$1`, [ORG_ID])).rows[0].flags,
  };
}
async function restoreControls(c: Client, saved: Awaited<ReturnType<typeof readControls>>) {
  await c.query(`DELETE FROM platform_settings WHERE key='lease_renewal'`);
  if (saved.global !== null) {
    await c.query(`INSERT INTO platform_settings SELECT * FROM jsonb_populate_record(NULL::platform_settings, $1::jsonb)`, [saved.global]);
  }
  await c.query(`UPDATE organizations SET feature_flags=$2::jsonb WHERE id=$1`, [ORG_ID, saved.org]);
  assert.deepEqual(await readControls(c), saved, "controls restored exactly");
}
let savedControls: Awaited<ReturnType<typeof readControls>>;
test.beforeEach(async () => {
  const c = new Client({ connectionString: process.env.DATABASE_URL });
  await c.connect();
  try { savedControls = await readControls(c); } finally { await c.end(); }
});
test.afterEach(async () => {
  const c = new Client({ connectionString: process.env.DATABASE_URL });
  await c.connect();
  try { await restoreControls(c, savedControls); } finally { await c.end(); }
});

async function enableComparison(c: Client) {
  await c.query(`INSERT INTO platform_settings(key,value) VALUES('lease_renewal',jsonb_build_object('enabled',true,'allowed_org_ids',jsonb_build_array($1::text))) ON CONFLICT(key) DO UPDATE SET value=excluded.value`, [ORG_ID]);
  await c.query(`UPDATE organizations SET feature_flags=feature_flags || '{"lease_renewal":true}'::jsonb WHERE id=$1`, [ORG_ID]);
}

const proposal: RenewalInput = {
  startDate: "2031-01-01", endMode: "date", endDate: "2031-12-31",
  rent: "123.45", frequency: "quarterly", dueDay: "15", deposit: "250.00",
};
const sameTerms: RenewalInput = {
  startDate: "2030-01-01", endMode: "date", endDate: "2030-12-31",
  rent: "100.00", frequency: "monthly", dueDay: "1", deposit: "200.00",
};
const allUnchanged = { startDate: false, endDate: false, rent: false, frequency: false, dueDay: false, deposit: false };

async function comparisonFixture(c: Client) {
  const token = randomUUID(), sid = randomUUID();
  await c.query(`INSERT INTO auth_sessions(id,user_id,token_hash,expires_at) VALUES($1,$2,$3,clock_timestamp()+interval '1 hour')`, [sid, USERS.manager, sessionTokenHash(token)]);
  const session: Session = { userId: USERS.manager, orgId: ORG_ID, liveOrgId: ORG_ID, sessionId: sid, kind: "staff", role: "manager", environment: "live", locale: "en", calendar: "gregorian", leaseId: null, email: "synthetic@example.test", name: "Synthetic" };
  const property = (await c.query<{ id: string }>(`INSERT INTO properties(org_id,name,country_code,currency,timezone,default_rental_mode) VALUES($1,'B012 synthetic','US','USD','UTC','whole_unit') RETURNING id::text`, [ORG_ID])).rows[0].id;
  const unit = (await c.query<{ id: string }>(`INSERT INTO units(org_id,property_id,label,rental_mode) VALUES($1,$2,'B012 synthetic','whole_unit') RETURNING id::text`, [ORG_ID, property])).rows[0].id;
  const lease = (await c.query<{ id: string }>(`INSERT INTO leases(org_id,property_id,unit_id,target_unit_id,status,start_date,end_date,currency,rent_amount_minor,rent_frequency,due_day,deposit_amount_minor) VALUES($1,$2,$3,$3,'ended','2030-01-01','2030-12-31','USD',10000,'monthly',1,20000) RETURNING id::text`, [ORG_ID, property, unit])).rows[0].id;
  await c.query(`INSERT INTO lease_parties(org_id,lease_id,contact_id,role) SELECT $1,$2,id,'primary' FROM contacts WHERE org_id=$1 AND user_id=$3 LIMIT 1`, [ORG_ID, lease, USERS.tenant]);
  return { session, lease, token };
}

// Full rows, not counts: catches updates, deletes and inserted audit/history rows.
// Include private app tables and controls; only session-touch bookkeeping is excluded.
async function domainSnapshot(c: Client) {
  const tables = (await c.query<{ schemaname: string; tablename: string }>(`SELECT schemaname,tablename FROM pg_tables WHERE schemaname IN ('public','app') AND tablename <> 'auth_sessions' ORDER BY schemaname,tablename`)).rows;
  const rows: Record<string, string[]> = {};
  for (const { schemaname, tablename } of tables) {
    const ident = (s: string) => `"${s.replaceAll('"', '""')}"`;
    rows[`${schemaname}.${tablename}`] = (await c.query<{ row: string }>(`SELECT to_jsonb(t)::text AS row FROM ${ident(schemaname)}.${ident(tablename)} t ORDER BY to_jsonb(t)::text`)).rows.map(r => r.row);
  }
  return rows;
}
test("renewal preview uses current authenticated context, strict flags and fresh lease data",async()=>{
 const c=new Client({connectionString:process.env.DATABASE_URL});await c.connect();try{
  const sid=randomUUID();await c.query(`INSERT INTO auth_sessions(id,user_id,token_hash,expires_at) VALUES($1,$2,$3,clock_timestamp()+interval '1 hour')`,[sid,USERS.manager,randomUUID()]);
  const s:Session={userId:USERS.manager,orgId:ORG_ID,liveOrgId:ORG_ID,sessionId:sid,kind:'staff',role:'manager',environment:'live',locale:'en',calendar:'gregorian',leaseId:null,email:'synthetic@example.test',name:'Synthetic'};
  const lease=(await c.query<{id:string}>(`SELECT id::text FROM leases WHERE org_id=$1 AND status='active' ORDER BY id LIMIT 1`,[ORG_ID])).rows[0];assert.ok(lease);
  await c.query(`DELETE FROM platform_settings WHERE key='lease_renewal'`);await c.query(`UPDATE organizations SET feature_flags=feature_flags || '{"lease_renewal":true}'::jsonb WHERE id=$1`,[ORG_ID]);assert.equal(await renewalComparisonView(s,lease.id),null);
  await c.query(`INSERT INTO platform_settings(key,value) VALUES ('lease_renewal','{"enabled":"true","allowed_org_ids":[]}'::jsonb)`);assert.equal(await renewalComparisonView(s,lease.id),null);
  await c.query(`UPDATE platform_settings SET value=jsonb_build_object('enabled',true,'allowed_org_ids',jsonb_build_array($1::text,123)) WHERE key='lease_renewal'`,[ORG_ID]);assert.equal(await renewalComparisonView(s,lease.id),null);
  await c.query(`UPDATE platform_settings SET value=jsonb_build_object('enabled',true,'allowed_org_ids',jsonb_build_array($1::text)) WHERE key='lease_renewal'`,[ORG_ID]);
  const view=await renewalComparisonView(s,lease.id);assert.ok(view);assert.equal(await renewalComparisonView({...s,role:'accountant'},lease.id),null);assert.equal(await renewalComparisonView({...s,needsSandbox:true},lease.id),null);assert.equal(await renewalComparisonView({...s,sessionId:randomUUID()},lease.id),null);assert.equal(await renewalComparisonView({...s,orgId:randomUUID()},lease.id),null);
  const accountantSid=randomUUID();await c.query(`INSERT INTO auth_sessions(id,user_id,token_hash,expires_at) VALUES($1,$2,$3,clock_timestamp()+interval '1 hour')`,[accountantSid,USERS.accountant,randomUUID()]);assert.equal(await renewalComparisonView({...s,userId:USERS.accountant,sessionId:accountantSid,role:'accountant'},lease.id),null);assert.equal(await renewalComparisonView({...s,kind:'tenant',role:null,userId:USERS.tenant},lease.id),null);assert.equal(await renewalComparisonView(s,randomUUID()),null);
  const i={startDate:view.terms.startDate,endMode:"date",endDate:view.terms.startDate,rent:renewalMajor(view.terms.rentMinor,view.terms.minorUnit),frequency:view.terms.frequency,dueDay:String(view.terms.dueDay),deposit:renewalMajor(view.terms.depositMinor,view.terms.minorUnit)};
  const before=(await c.query(`SELECT (SELECT count(*) FROM leases)::text leases,(SELECT count(*) FROM payments)::text payments,(SELECT count(*) FROM invoices)::text invoices,(SELECT count(*) FROM ledger_transactions)::text ledger`)).rows[0];
  const result=await compareRenewal(s,lease.id,view.fingerprint,i);assert.equal(result.state,'ready');if(result.state==='ready'){assert.equal(result.overlap,true);assert.equal(result.current.rentMinor,view.terms.rentMinor);assert.equal(result.proposed.depositMinor,view.terms.depositMinor);}
  assert.equal((await compareRenewal(s,lease.id,view.fingerprint,{...i,rent:'1e5'})).state,'invalid');assert.deepEqual((await c.query(`SELECT (SELECT count(*) FROM leases)::text leases,(SELECT count(*) FROM payments)::text payments,(SELECT count(*) FROM invoices)::text invoices,(SELECT count(*) FROM ledger_transactions)::text ledger`)).rows[0],before);
  await c.query(`UPDATE leases SET notes=coalesce(notes,'') || ' synthetic' WHERE id=$1`,[lease.id]);assert.equal((await compareRenewal(s,lease.id,view.fingerprint,i)).state,'stale');
  await c.query(`UPDATE auth_sessions SET revoked_at=clock_timestamp() WHERE id=$1`,[sid]);assert.equal(await renewalComparisonView(s,lease.id),null);
 }finally{await c.end();}
});

test("inclusive unbounded conflicts respect whole-unit and separate-room scope",async()=>{
 const c=new Client({connectionString:process.env.DATABASE_URL});await c.connect();try{
  const sid=randomUUID();await c.query(`INSERT INTO auth_sessions(id,user_id,token_hash,expires_at) VALUES($1,$2,$3,clock_timestamp()+interval '1 hour')`,[sid,USERS.manager,randomUUID()]);
  await c.query(`INSERT INTO platform_settings(key,value) VALUES('lease_renewal',jsonb_build_object('enabled',true,'allowed_org_ids',jsonb_build_array($1::text))) ON CONFLICT(key) DO UPDATE SET value=excluded.value`,[ORG_ID]);await c.query(`UPDATE organizations SET feature_flags=feature_flags || '{"lease_renewal":true}'::jsonb WHERE id=$1`,[ORG_ID]);
  const property=(await c.query<{id:string;currency:string}>(`SELECT id::text,currency::text FROM properties WHERE org_id=$1 AND archived_at IS NULL LIMIT 1`,[ORG_ID])).rows[0];assert.ok(property);
  const unit=(await c.query<{id:string}>(`INSERT INTO units(org_id,property_id,label,rental_mode) VALUES($1,$2,$3,'whole_unit') RETURNING id::text`,[ORG_ID,property.id,randomUUID()])).rows[0].id;
  const whole=(await c.query<{id:string}>(`INSERT INTO leases(org_id,property_id,unit_id,target_unit_id,status,start_date,end_date,currency,rent_amount_minor) VALUES($1,$2,$3,$3,'ended','2029-01-01','2029-12-31',$4,10000) RETURNING id::text`,[ORG_ID,property.id,unit,property.currency])).rows[0].id;
  await c.query(`UPDATE units SET rental_mode='by_room' WHERE id=$1`,[unit]);
  const a=(await c.query<{id:string}>(`INSERT INTO rooms(org_id,unit_id,label) VALUES($1,$2,'synthetic-a') RETURNING id::text`,[ORG_ID,unit])).rows[0].id;
  const b=(await c.query<{id:string}>(`INSERT INTO rooms(org_id,unit_id,label) VALUES($1,$2,'synthetic-b') RETURNING id::text`,[ORG_ID,unit])).rows[0].id;
  const room=(await c.query<{id:string}>(`INSERT INTO leases(org_id,property_id,unit_id,target_room_id,status,start_date,end_date,currency,rent_amount_minor) VALUES($1,$2,$3,$4,'ended','2029-01-01','2029-12-31',$5,10000) RETURNING id::text`,[ORG_ID,property.id,unit,a,property.currency])).rows[0].id;
  const pending=(await c.query<{id:string}>(`INSERT INTO leases(org_id,property_id,unit_id,target_room_id,status,start_date,end_date,currency,rent_amount_minor) VALUES($1,$2,$3,$4,'pending_signature','2031-01-01',NULL,$5,10000) RETURNING id::text`,[ORG_ID,property.id,unit,b,property.currency])).rows[0].id;
  const s:Session={userId:USERS.manager,orgId:ORG_ID,liveOrgId:ORG_ID,sessionId:sid,kind:'staff',role:'manager',environment:'live',locale:'en',calendar:'gregorian',leaseId:null,email:'synthetic@example.test',name:'Synthetic'};
  for(const [id,expected] of [[whole,true],[room,false]] as const){const view=await renewalComparisonView(s,id);assert.ok(view);const i={startDate:'2031-01-01',endMode:'date',endDate:'2031-01-01',rent:renewalMajor(view.terms.rentMinor,view.terms.minorUnit),frequency:view.terms.frequency,dueDay:String(view.terms.dueDay),deposit:renewalMajor(view.terms.depositMinor,view.terms.minorUnit)};const r=await compareRenewal(s,id,view.fingerprint,i);assert.equal(r.state,'ready');if(r.state==='ready')assert.equal(r.overlap,expected); if(id===whole){const finite=await compareRenewal(s,id,view.fingerprint,{...i,startDate:'2030-01-01',endDate:'2030-12-31'});assert.equal(finite.state,'ready');if(finite.state==='ready')assert.equal(finite.overlap,false);const open=await compareRenewal(s,id,view.fingerprint,{...i,startDate:'2030-01-01',endMode:'open_ended',endDate:''});assert.equal(open.state,'ready');if(open.state==='ready'){assert.equal(open.proposed.endDate,null);assert.equal(open.overlap,true);}}}
  const ongoing=await renewalComparisonView(s,pending);assert.ok(ongoing);assert.equal(ongoing.terms.endDate,null);const unbounded=await compareRenewal(s,pending,ongoing.fingerprint,{startDate:'2050-01-01',endMode:'open_ended',endDate:'',rent:renewalMajor(ongoing.terms.rentMinor,ongoing.terms.minorUnit),frequency:ongoing.terms.frequency,dueDay:String(ongoing.terms.dueDay),deposit:renewalMajor(ongoing.terms.depositMinor,ongoing.terms.minorUnit)});assert.equal(unbounded.state,'ready');if(unbounded.state==='ready')assert.equal(unbounded.overlap,true);
 }finally{await c.end();}
});

test("comparison exposes every changed term without domain writes", async () => {
  const c = new Client({ connectionString: process.env.DATABASE_URL });
  await c.connect();
  try {
    const { session, lease } = await comparisonFixture(c);
    await enableComparison(c);
    const view = await renewalComparisonView(session, lease);
    assert.ok(view);
    assert.deepEqual(view.terms, {
      startDate: "2030-01-01", endDate: "2030-12-31", rentMinor: "10000",
      frequency: "monthly", dueDay: 1, depositMinor: "20000", currency: "USD", minorUnit: 2,
    });
    const before = await domainSnapshot(c);
    const changed = await compareRenewal(session, lease, view.fingerprint, proposal);
    assert.equal(changed.state, "ready");
    if (changed.state !== "ready") assert.fail("comparison must be ready");
    assert.deepEqual(changed.current, view.terms);
    assert.deepEqual(changed.proposed, {
      startDate: "2031-01-01", endDate: "2031-12-31", rentMinor: "12345",
      frequency: "quarterly", dueDay: 15, depositMinor: "25000", currency: "USD", minorUnit: 2,
    });
    assert.deepEqual(changed.diff, {
      startDate: true, endDate: true, rent: true, frequency: true, dueDay: true, deposit: true,
    });
    assert.equal(changed.overlap, false);
    const same = await compareRenewal(session, lease, view.fingerprint, sameTerms);
    assert.equal(same.state, "ready");
    if (same.state !== "ready") assert.fail("identical terms must be ready");
    assert.deepEqual(same.proposed, view.terms);
    assert.deepEqual(same.diff, allUnchanged);
    for (const key of Object.keys(allUnchanged) as (keyof typeof allUnchanged)[]) {
      const value = key === "startDate" ? "2030-02-01" : proposal[key];
      const single = await compareRenewal(session, lease, view.fingerprint, { ...sameTerms, [key]: value });
      assert.equal(single.state, "ready", key);
      if (single.state !== "ready") assert.fail(key);
      assert.deepEqual(single.diff, { ...allUnchanged, [key]: true }, key);
    }
    assert.deepEqual(await domainSnapshot(c), before);
  } finally { await c.end(); }
});

test("missing terms reject independently without domain writes, including open-ended mode", async () => {
  const c = new Client({ connectionString: process.env.DATABASE_URL });
  await c.connect();
  try {
    const { session, lease } = await comparisonFixture(c);
    await enableComparison(c);
    const view = await renewalComparisonView(session, lease);
    assert.ok(view);
    const before = await domainSnapshot(c);
    for (const endMode of ["date", "open_ended"] as const) {
      const valid = { ...proposal, endMode, endDate: endMode === "date" ? proposal.endDate : "" };
      const accepted = await compareRenewal(session, lease, view.fingerprint, valid);
      assert.equal(accepted.state, "ready", endMode);
      if (accepted.state !== "ready") assert.fail(endMode);
      assert.equal(accepted.proposed.endDate, endMode === "date" ? proposal.endDate : null);
      for (const key of Object.keys(valid) as (keyof RenewalInput)[]) {
        const omitted: Partial<RenewalInput> = { ...valid };
        delete omitted[key];
        const candidates = [omitted, { ...valid, [key]: " " }];
        if (endMode !== "open_ended" || key !== "endDate") candidates.push({ ...valid, [key]: "" });
        for (const input of candidates) {
          const label = `${endMode}: ${key}=${JSON.stringify(input[key])}`;
          assert.deepEqual(await compareRenewal(session, lease, view.fingerprint, input as RenewalInput), { state: "invalid" }, label);
          assert.deepEqual(await domainSnapshot(c), before, label);
        }
      }
    }
  } finally { await c.end(); }
});

test("OFF preserves legacy lease data, hides entry, returns 404 and rejects direct actions with zero domain changes", async (t) => {
  const c = new Client({ connectionString: process.env.DATABASE_URL });
  await c.connect();
  try {
    const { session, lease, token } = await comparisonFixture(c);
    t.mock.method(nextHeaders, "cookies", async () => ({
      get(name: string) {
        const values: Record<string, string> = { [SESSION_COOKIE]: token, condola_locale: "en", condola_env: "live" };
        return values[name] ? { value: values[name] } : undefined;
      },
    }));
    t.mock.method(nextHeaders, "headers", async () => new Headers({ "x-pathname": `/m/leases/${lease}/renewal` }));
    await c.query(`DELETE FROM platform_settings WHERE key='lease_renewal'`);
    await c.query(`UPDATE organizations SET feature_flags=feature_flags - 'lease_renewal' WHERE id=$1`, [ORG_ID]);
    const legacy = await leaseDetail(session, lease);
    assert.ok(legacy, "legacy data baseline must exist");
    assert.equal(legacy.lease.rent, "10000");
    assert.equal(legacy.lease.deposit, "20000");
    assert.equal(legacy.lease.due_day, 1);
    assert.equal(legacy.lease.start_date, "2030-01-01");
    assert.equal(legacy.lease.end_date, "2030-12-31");
    const baseline = JSON.stringify(legacy);
    await enableComparison(c);
    const view = await renewalComparisonView(session, lease);
    assert.ok(view, "positive control: same session and lease are authorized when enabled");
    assert.equal((await compareRenewalAction(lease, view.fingerprint, proposal)).state, "ready");
    // tsx uses classic JSX here; restore the global after rendering the real components.
    const previousReact = Object.getOwnPropertyDescriptor(globalThis, "React");
    Object.defineProperty(globalThis, "React", { value: React, configurable: true, writable: true });
    try {
      const entry = await RenewalComparisonEntry({ session, leaseId: lease });
      assert.ok(entry, "positive control: enabled renewal entry must exist");
      const entryHtml = renderToStaticMarkup(entry);
      assert.match(entryHtml, /<a\b[^>]*data-testid="renewal-entry"/);
      assert.ok(entryHtml.includes(`href="/m/leases/${lease}/renewal"`), "entry links to this lease's renewal page");
      await assert.doesNotReject(async () => {
        const page = await RenewalPage({ params: Promise.resolve({ id: lease }) });
        assert.ok(page, "positive control: enabled renewal page must exist");
        const pageHtml = renderToStaticMarkup(page);
        assert.ok(pageHtml.includes(`<h1>${renewalCopy(session.locale).title}</h1>`));
        assert.match(pageHtml, /<form\b/);
      }, "positive control: real renewal page renders without a 404 signal");
    } finally {
      if (previousReact) Object.defineProperty(globalThis, "React", previousReact);
      else Reflect.deleteProperty(globalThis, "React");
    }
    const enabled = { enabled: true, allowed_org_ids: [ORG_ID] };
    const cases: { name: string; global?: unknown; org?: unknown }[] = [
      { name: "absent global", org: true },
      { name: "false global", global: { ...enabled, enabled: false }, org: true },
      { name: "string-true global", global: { ...enabled, enabled: "true" }, org: true },
      { name: "null global", global: null, org: true },
      { name: "scalar global", global: true, org: true },
      { name: "array global", global: [enabled], org: true },
      { name: "missing enabled", global: { allowed_org_ids: [ORG_ID] }, org: true },
      { name: "missing allowlist", global: { enabled: true }, org: true },
      { name: "null allowlist", global: { enabled: true, allowed_org_ids: null }, org: true },
      { name: "scalar allowlist", global: { enabled: true, allowed_org_ids: ORG_ID }, org: true },
      { name: "object allowlist", global: { enabled: true, allowed_org_ids: { [ORG_ID]: true } }, org: true },
      { name: "mixed allowlist", global: { enabled: true, allowed_org_ids: [ORG_ID, 123] }, org: true },
      { name: "invalid UUID allowlist", global: { enabled: true, allowed_org_ids: [ORG_ID, "invalid"] }, org: true },
      { name: "empty allowlist", global: { enabled: true, allowed_org_ids: [] }, org: true },
      { name: "other org allowlist", global: { enabled: true, allowed_org_ids: [randomUUID()] }, org: true },
      { name: "absent org flag", global: enabled },
      { name: "false org flag", global: enabled, org: false },
      { name: "string-true org flag", global: enabled, org: "true" },
      { name: "null org flag", global: enabled, org: null },
      { name: "object org flag", global: enabled, org: { enabled: true } },
      { name: "array org flag", global: enabled, org: [true] },
    ];
    for (const control of cases) {
        await c.query(`DELETE FROM platform_settings WHERE key='lease_renewal'`);
        if (control.global !== undefined) {
          await c.query(`INSERT INTO platform_settings(key,value) VALUES('lease_renewal',$1::jsonb)`, [JSON.stringify(control.global)]);
        }
        await c.query(`UPDATE organizations SET feature_flags=(feature_flags - 'lease_renewal') || $2::jsonb WHERE id=$1`, [ORG_ID, JSON.stringify(control.org === undefined ? {} : { lease_renewal: control.org })]);
        const before = await domainSnapshot(c);
        assert.equal(await renewalComparisonView(session, lease), null, control.name);
        assert.deepEqual(await compareRenewal(session, lease, view.fingerprint, proposal), { state: "unavailable" }, control.name);
        assert.deepEqual(await compareRenewalAction(lease, view.fingerprint, proposal), { state: "unavailable" }, control.name);
        assert.equal(await RenewalComparisonEntry({ session, leaseId: lease }), null, control.name);
        await assert.rejects(RenewalPage({ params: Promise.resolve({ id: lease }) }), (error: unknown) => (
          typeof error === "object" && error !== null && "digest" in error && error.digest === "NEXT_HTTP_ERROR_FALLBACK;404"
        ), control.name);
        assert.equal(JSON.stringify(await leaseDetail(session, lease)), baseline, control.name);
        assert.deepEqual(await domainSnapshot(c), before, control.name);
    }
  } finally { await c.end(); }
});

for (const existing of [false, true]) {
  test(`controls restore exactly from ${existing ? "pre-existing OFF row with metadata" : "absent global row"}, even on failure`, async () => {
    const c = new Client({ connectionString: process.env.DATABASE_URL });
    await c.connect();
    try {
      const { session, lease } = await comparisonFixture(c);
      await c.query(`DELETE FROM platform_settings WHERE key='lease_renewal'`);
      if (existing) {
        await c.query(`INSERT INTO platform_settings(key,value,description,updated_at) VALUES('lease_renewal','{"enabled":false,"allowed_org_ids":[],"retained":{"reason":"synthetic OFF baseline"}}','B012 original description','2030-01-02 03:04:05.123456+00')`);
      }
      await c.query(`UPDATE organizations SET feature_flags=$2::jsonb WHERE id=$1`, [ORG_ID, JSON.stringify({ lease_renewal: false, unrelated: { keep: [1, "true", null] } })]);
      const original = await readControls(c);
      const failure = new Error("synthetic assertion failure");
      for (const fail of [false, true]) {
        const exercise = async () => {
          try {
            await enableComparison(c);
            const view = await renewalComparisonView(session, lease);
            assert.ok(view);
            assert.equal((await compareRenewal(session, lease, view.fingerprint, proposal)).state, "ready");
            if (fail) throw failure;
          } finally { await restoreControls(c, original); }
        };
        if (fail) await assert.rejects(exercise(), error => error === failure);
        else await exercise();
        assert.deepEqual(await readControls(c), original);
        assert.equal(await renewalComparisonView(session, lease), null);
      }
    } finally { await c.end(); }
  });
}
