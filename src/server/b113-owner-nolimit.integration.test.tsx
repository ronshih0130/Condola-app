import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { Client } from "pg";
import { AppRouterContext } from "next/dist/shared/lib/app-router-context.shared-runtime";
import { RulesView } from "../components/v3/o/rules/rules";
import { ownerRuleView } from "./b091-owner-rules";
import { ownerRulesPage, type RepairLimitLine } from "./b094-owner-rules";
import { ORG_ID, ORG2_ID, USERS } from "./ids";
import { changeOwnerRepairDefault, ownerRepairPolicyView } from "./repair-owner-policy";
import { resetAndSeed } from "./seed";
import { cloneTestDatabase } from "./test-database-clone";
import { disposableDbUrl } from "./test-disposable-db";
import type { Session } from "./types";
Object.assign(globalThis, { React });

// B-113 / R8-OWNRULE, OWN-34-AC6 on a cloned disposable database: RO-RULES reads B-021's real resolution
// (b013_owner_view: per-property override → the owner's own default → the regional default) through the real
// gateways and service_role. No SQL changed in B-113; this proves the page states against the real view. Synthetic data.
disposableDbUrl(process.env.DATABASE_URL, process.env.CONDOLA_RLS_DISPOSABLE);
let clone: Awaited<ReturnType<typeof cloneTestDatabase>> | undefined;
let db: Client;
const sid: Record<string, string> = {};
const v3 = async () => true;
const router = { back() {}, forward() {}, refresh() {}, push() {}, replace() {}, prefetch() {} };
const owner = (who: "owner" | "owner2", org = ORG_ID): Session => ({ kind: "owner", role: null, orgId: org, liveOrgId: org, userId: USERS[who], sessionId: sid[who],
  name: "Synthetic", email: "", environment: "live", locale: "zh-TW", calendar: "gregorian", leaseId: null });
const page = (session: Session) => ownerRulesPage(session, { rule: s => ownerRuleView(s, { v3 }) });
async function lines(session: Session): Promise<RepairLimitLine[]> {
  const result = await page(session);
  assert.equal(result.state, "ready");
  return result.state === "ready" ? result.repairs : [];
}
function text(repairs: RepairLimitLine[]) {
  return renderToStaticMarkup(<AppRouterContext.Provider value={router}>
    <RulesView locale="zh-TW" company="松信住宅管理" rule="delegate_notify" revision={0} repairs={repairs} />
  </AppRouterContext.Provider>).replace(/<[^>]+>/g, "|");
}
async function ownDefault(session: Session, property: string, action: "set" | "clear", value: string) {
  const view = await ownerRepairPolicyView(session, property);
  assert.ok(view.state === "enabled");
  const result = await changeOwnerRepairDefault(session, { propertyId: property, requestId: randomUUID(), expected: view.snapshot, action, value });
  assert.equal(result.status === "recorded" ? result.outcome : result.status, "changed");
}
const ownedBy = async (user: string) => (await db.query(`SELECT DISTINCT po.property_id::text id FROM property_owners po JOIN contacts c ON c.org_id=po.org_id AND c.id=po.owner_contact_id
  WHERE po.org_id=$1 AND c.user_id=$2 AND c.is_owner AND po.effective_from<=current_date AND (po.effective_to IS NULL OR po.effective_to>current_date) ORDER BY 1`, [ORG_ID, user])).rows.map(r => r.id as string);

test.before(async () => {
  clone = await cloneTestDatabase();
  db = new Client({ connectionString: process.env.DATABASE_URL });
  await db.connect();
  const demo = process.env.DEMO_MODE, key = process.env.ID_DOC_ENCRYPTION_KEY;
  try {
    process.env.DEMO_MODE = "true";
    process.env.ID_DOC_ENCRYPTION_KEY = randomBytes(32).toString("hex");
    await resetAndSeed();
  } finally {
    if (demo === undefined) delete process.env.DEMO_MODE; else process.env.DEMO_MODE = demo;
    if (key === undefined) delete process.env.ID_DOC_ENCRYPTION_KEY; else process.env.ID_DOC_ENCRYPTION_KEY = key;
  }
  for (const who of ["owner", "owner2", "admin"] as const) {
    sid[who] = randomUUID();
    await db.query("INSERT INTO public.auth_sessions(id,user_id,token_hash,expires_at) VALUES($1,$2,$3,clock_timestamp()+interval '2 hours')", [sid[who], USERS[who], randomUUID()]);
  }
  for (const key of ["repair_approvals", "owner_rules"]) {
    await db.query("UPDATE public.platform_settings SET value=jsonb_build_object('enabled',true,'allowed_org_ids',jsonb_build_array($1::text)) WHERE key=$2", [ORG_ID, key]);
    await db.query("UPDATE public.organizations SET feature_flags=feature_flags||jsonb_build_object($2::text,true) WHERE id=$1", [ORG_ID, key]);
  }
  await db.query("UPDATE public.property_owners SET repair_approval_threshold_minor=NULL WHERE org_id=$1", [ORG_ID]);
});
test.after(async () => { try { if (db) await db.end(); } finally { await clone?.cleanup(); } });

test("OWN-34-AC6: not set → the regional default (TW/TWD 500000 at minor unit 2 = NT$5,000, read from the view); NT$0 is a limit; clear returns to the default", async () => {
  const s = owner("owner");
  const regional = await lines(s);
  assert.ok(regional.length >= 1, "the seeded owner has at least one property line");
  for (const line of regional) assert.deepEqual([line.state, line.minor, line.currency, line.minorUnit], ["regional", "500000", "TWD", 2], line.name);
  const t = text(regional);
  for (const line of regional) assert.ok(t.includes(`${line.name}・你還沒設定，目前用預設：NT$5,000 以下直接修`), line.name);
  assert.doesNotMatch(t, /每一筆都會先問你|請先設定/);
  const first = regional[0].propertyId;
  // The owner's own default (per currency) of 0: a real limit, so every estimate asks — never "not set".
  await ownDefault(s, first, "set", "0");
  for (const line of await lines(s)) assert.deepEqual([line.state, line.minor], ["zero", "0"], line.name);
  assert.ok(text(await lines(s)).includes(`${regional[0].name}・每一筆都會先問你`));
  await ownDefault(s, first, "set", "600000");
  for (const line of await lines(s)) assert.deepEqual([line.state, line.minor], ["owner", "600000"], line.name);
  assert.ok(text(await lines(s)).includes(`${regional[0].name}・NT$6,000 以下直接修`));
  // 'clear' is "not set" again: back to the regional default, not to 0.
  await ownDefault(s, first, "clear", "");
  for (const line of await lines(s)) assert.deepEqual([line.state, line.minor], ["regional", "500000"], line.name);
});

test("OWN-34-AC6: no regional default for the property's currency → 「請先設定」 with a solid 「設定」; an unconfirmed legacy override shows no amount", async () => {
  const s = owner("owner");
  const [first] = await lines(s);
  const previous = (await db.query("SELECT currency FROM public.properties WHERE id=$1", [first.propertyId])).rows[0].currency;
  await db.query("UPDATE public.properties SET currency='USD' WHERE id=$1", [first.propertyId]);
  try {
    const line = (await lines(s)).find(l => l.propertyId === first.propertyId)!;
    assert.deepEqual([line.state, line.minor, line.currency], ["unset", null, "USD"]);
    const html = renderToStaticMarkup(<AppRouterContext.Provider value={router}><RulesView locale="zh-TW" company="x" rule="delegate_notify" revision={0} repairs={[line]} /></AppRouterContext.Provider>);
    assert.match(html, new RegExp(`${first.name}・還沒設定上限，請先設定，廠商才能送估價`));
    assert.match(html, /class="owner-action owner-primary"[^>]*>設定</);
  } finally {
    await db.query("UPDATE public.properties SET currency=$2 WHERE id=$1", [first.propertyId, previous]);
  }
  // A raw per-property value without its B-021 revision is not verified: the view says legacy_confirmation_required.
  await db.query("UPDATE public.property_owners SET repair_approval_threshold_minor=0 WHERE property_id=$1", [first.propertyId]);
  try {
    const line = (await lines(s)).find(l => l.propertyId === first.propertyId)!;
    assert.deepEqual([line.state, line.minor], ["pending", null]);
  } finally {
    await db.query("UPDATE public.property_owners SET repair_approval_threshold_minor=NULL WHERE property_id=$1", [first.propertyId]);
  }
});

test("OWN-34-AC6: an owner sees only their own current properties; cross-org, staff and a former owner read nothing", async () => {
  const mine = await ownedBy(USERS.owner), theirs = await ownedBy(USERS.owner2);
  const onlyTheirs = theirs.filter(id => !mine.includes(id));
  assert.ok(mine.length > 0 && onlyTheirs.length > 0, "the seed has properties for both owners");
  const seen = (await lines(owner("owner"))).map(l => l.propertyId);
  assert.ok(seen.length > 0 && seen.every(id => mine.includes(id)), "every line is one of the owner's own properties");
  assert.ok(!seen.some(id => onlyTheirs.includes(id)), "never another owner's property");
  const other = (await lines(owner("owner2"))).map(l => l.propertyId);
  assert.ok(other.length > 0 && other.every(id => theirs.includes(id)) && !other.some(id => !theirs.includes(id)));
  assert.notEqual((await page(owner("owner", ORG2_ID))).state, "ready", "cross-org");
  assert.notEqual((await page({ ...owner("owner"), kind: "staff", role: "admin", userId: USERS.admin, sessionId: sid.admin })).state, "ready", "staff");
  assert.notEqual((await page({ ...owner("owner"), sessionId: randomUUID() })).state, "ready", "unknown session");
  const rows = (await db.query("SELECT id,effective_to FROM public.property_owners po WHERE org_id=$1 AND owner_contact_id IN (SELECT id FROM contacts WHERE org_id=$1 AND user_id=$2)", [ORG_ID, USERS.owner])).rows;
  await db.query("UPDATE public.property_owners SET effective_to=effective_from WHERE id = ANY($1::uuid[])", [rows.map(r => r.id)]);
  try {
    const former = await page(owner("owner"));
    assert.ok(former.state !== "ready" || former.repairs.length === 0, "a former owner sees no repair line");
  } finally {
    for (const row of rows) await db.query("UPDATE public.property_owners SET effective_to=$2 WHERE id=$1", [row.id, row.effective_to]);
  }
  for (const role of ["anon", "authenticated"])
    assert.equal((await db.query("SELECT has_function_privilege($1,'app.b013_owner_view(uuid,uuid,text,uuid,uuid)','EXECUTE') ok", [role])).rows[0].ok, false, role);
});
