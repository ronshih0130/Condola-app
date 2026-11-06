import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import test from "node:test";
import { Client } from "pg";
import { myConsentRecords } from "./consent-records";
import { cloneTestDatabase } from "./test-database-clone";
import { disposableDbUrl } from "./test-disposable-db";
import type { Session } from "./types";

disposableDbUrl(process.env.DATABASE_URL, process.env.CONDOLA_RLS_DISPOSABLE);
let clone: Awaited<ReturnType<typeof cloneTestDatabase>>;
let db: Client;
const user = randomUUID(), other = randomUUID(), stranger = randomUUID();
const live = randomUUID(), otherOrg = randomUUID(), sandbox = randomUUID();
const digest = "a".repeat(64), legacyDigest = "b".repeat(64);
const at = "2026-11-01T12:00:00.000Z";
const expected = new Map<string, Set<string>>();

function session(orgId = live, environment: Session["environment"] = "live", userId = user): Session {
  return { userId, sessionId: randomUUID(), orgId, liveOrgId: live, environment,
    kind: "staff", role: "admin", email: "fixture@example.invalid", name: "Fixture",
    locale: "en", calendar: "gregorian", leaseId: null };
}
const hash = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");

async function seedEvidence(org: string, actor: string) {
  const member = randomUUID(), contact = randomUUID(), property = randomUUID();
  const unit = randomUUID(), lease = randomUUID();
  const ids = new Set<string>();
  await db.query(`INSERT INTO org_members(id,org_id,user_id,role) VALUES($1,$2,$3,'admin')`, [member, org, actor]);
  await db.query(`INSERT INTO contacts(id,org_id,user_id,is_tenant,display_name) VALUES($1,$2,$3,true,'Private fixture name')`, [contact, org, actor]);
  await db.query(`INSERT INTO properties(id,org_id,name,country_code,currency,timezone) VALUES($1,$2,'Fixture','US','USD','America/Los_Angeles')`, [property, org]);
  await db.query(`INSERT INTO units(id,org_id,property_id,label) VALUES($1,$2,$3,'101')`, [unit, org, property]);
  await db.query(`INSERT INTO leases(id,org_id,property_id,unit_id,target_unit_id,start_date,currency,rent_amount_minor,due_day)
    VALUES($1,$2,$3,$4,$4,'2026-01-01','USD',1000,1)`, [lease, org, property, unit]);
  for (const type of ["partner_agreement", "privacy"]) {
    const id = randomUUID(); ids.add(id);
    await db.query(`INSERT INTO partner_agreement_consents(id,company_id,user_id,doc_type,version,locale,document_sha256,consented_at,ip_address,user_agent,authority_attested,actor_role,consenter_name)
      VALUES($1,$2,$3,$4,'v1','en',$5,$6,'192.0.2.1','private-agent',true,'admin','Private fixture name')`, [id, org, actor, type, digest, at]);
  }
  // Modern and legacy consent columns, plus digest-only/time-only non-evidence.
  for (const variant of ["modern", "legacy", "digest_only", "time_only"]) {
    const id = randomUUID();
    if (variant === "modern" || variant === "legacy") ids.add(id);
    await db.query(`INSERT INTO identity_documents(id,org_id,contact_id,lease_id,doc_type,storage_path,encryption_key_ref,
        number_masked,number_hash,consent_notice_sha,consented_at,consent_notice_sha256,consent_accepted_at,deleted_at)
      VALUES($1,$2,$3,$4,'passport','private/storage/path','private-key','A******001','private-hash',
        $5,$6,$7,$8,now())`,
    [id, org, contact, lease, variant === "modern" || variant === "digest_only" ? digest : null,
      variant === "modern" || variant === "time_only" ? at : null,
      variant === "legacy" ? legacyDigest : null, variant === "legacy" ? at : null]);
  }
  for (const mode of ["contact", "member", "pending"]) {
    const id = randomUUID();
    if (mode !== "pending") ids.add(id);
    await db.query(`INSERT INTO lease_signatures(id,org_id,lease_id,signer_role,contact_id,member_id,status,document_sha256,signed_at,ip_address,user_agent)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,'192.0.2.1','private-agent')`,
    [id, org, lease, mode === "member" ? "manager" : "tenant", mode === "member" ? null : contact,
      mode === "member" ? member : null, mode === "pending" ? "pending" : "signed", digest, mode === "pending" ? null : at]);
  }
  const caseId = randomUUID(), version = randomUUID(), pdf = Buffer.from("synthetic document"), image = Buffer.from("synthetic signature image");
  await db.query(`INSERT INTO esign_cases(id,org_id,lease_id,created_by,retention_until) VALUES($1,$2,$3,$4,'infinity')`, [caseId, org, lease, actor]);
  await db.query(`INSERT INTO esign_versions(id,case_id,body,pdf_bytes,content_digest,state,retention_until)
    VALUES($1,$2,'Fixture',$3,$4,$5::jsonb,'infinity')`,
  [version, caseId, pdf, hash(pdf), JSON.stringify({ id: version, body: "Fixture", documentDigest: hash(pdf), status: "draft" })]);
  await db.query(`INSERT INTO esign_signers(version_id,id,party_role,email,email_step_state,state)
    VALUES($1,$2,'tenant','fixture@example.invalid','completed',$3::jsonb)`,
  [version, actor, JSON.stringify({ id: actor, role: "tenant", status: "pending_signature", consent: { at }, reviewedAt: at })]);
  // An unsigned signer must not appear in the read model.
  await db.query(`INSERT INTO esign_signers(version_id,id,party_role,email,state)
    VALUES($1,$2,'owner','unsigned@example.invalid',$3::jsonb)`,
  [version, stranger, JSON.stringify({ id: stranger, role: "owner" })]);
  await db.query(`INSERT INTO esign_signature_images(version_id,signer_id,image_bytes,image_digest,document_digest,signed_at,ip_address,device_id,user_agent)
    VALUES($1,$2,$3,$4,$5,$6,'192.0.2.1','private-device','private-agent')`, [version, actor, image, hash(image), hash(pdf), at]);
  await db.query(`UPDATE esign_signers SET signed_at=$3 WHERE version_id=$1 AND id=$2`, [version, actor, at]);
  ids.add(`${version}:${actor}`);
  return ids;
}

test.before(async () => {
  clone = await cloneTestDatabase();
  db = new Client({ connectionString: clone.url });
  await db.connect();
  for (const actor of [user, other, stranger]) {
    await db.query(`INSERT INTO auth.users(id,email,role,aud) VALUES($1,$2,'authenticated','authenticated')`, [actor, `${actor}@example.invalid`]);
    await db.query(`INSERT INTO consents(user_id,accepted_at,terms_version,privacy_version,source) VALUES($1,$2,'terms-v1','privacy-v1','signup')`, [actor, "2026-10-01T12:00:00Z"]);
  }
  for (const org of [live, otherOrg, sandbox]) {
    await db.query(`INSERT INTO organizations(id,name,country_code,default_currency,timezone,environment,live_org_id)
      VALUES($1,'Consent fixture','US','USD','America/Los_Angeles',$2,$3)`, [org, org === sandbox ? "sandbox" : "live", org === sandbox ? live : null]);
    expected.set(org, await seedEvidence(org, user));
    await seedEvidence(org, other);
  }
});
test.after(async () => { await db?.end(); await clone?.cleanup(); });

async function raw(actor: string, org: string, env: string, role = "authenticated") {
  await db.query("BEGIN");
  try {
    await db.query(`SELECT set_config('request.jwt.claim.sub',$1,true),set_config('app.active_org_id',$2,true),set_config('app.env',$3,true)`, [actor, org, env]);
    assert.ok(["authenticated", "anon", "service_role"].includes(role));
    await db.query(`SET LOCAL ROLE ${role}`);
    return (await db.query(`SELECT * FROM app.prop04_my_consent_records()`)).rows;
  } finally { await db.query("ROLLBACK"); }
}

test("own records include every kind and both signature sources, with only safe fields and stable ordering", async () => {
  const rows = await myConsentRecords(session());
  assert.equal(rows.length, expected.get(live)!.size + 1);
  assert.deepEqual(new Set(rows.filter((r) => r.scope_org_id).map((r) => r.record_id)), expected.get(live));
  assert.deepEqual(new Set(rows.map((r) => r.kind)), new Set(["terms_privacy", "partner_agreement", "partner_privacy", "id_notice", "lease_signature"]));
  assert.deepEqual(new Set(rows.filter((r) => r.kind === "lease_signature").map((r) => r.source)), new Set(["lease_signatures", "esign_signers"]));
  assert.deepEqual(rows.filter((r) => r.kind === "id_notice").map((r) => r.document_ref).sort(), [digest, legacyDigest]);
  assert.equal(rows.find((r) => r.kind === "terms_privacy")!.document_ref, "terms-v1|privacy-v1");
  assert.equal(rows.find((r) => r.kind === "partner_privacy")!.document_ref, `privacy:v1:${digest}`);
  for (const row of rows) assert.deepEqual(Object.keys(row).sort(), ["accepted_at", "document_ref", "kind", "record_id", "scope_org_id", "source"]);
  assert.doesNotMatch(JSON.stringify(rows), /A\*{6}001|private-(?:agent|hash|key|device)|private\/storage|192\.0\.2\.1|Private fixture/);
  assert.deepEqual(rows, await myConsentRecords(session()));
  for (let i = 1; i < rows.length; i++) assert.ok(Date.parse(rows[i - 1].accepted_at) >= Date.parse(rows[i].accepted_at));
  const otherRows = await myConsentRecords(session(live, "live", other));
  assert.ok(otherRows.every((row) => !rows.some((own) => own.record_id === row.record_id)));
  assert.equal((await myConsentRecords(session(live, "live", stranger))).length, 1);
});

test("org and live/sandbox pins isolate all scoped sources even with membership in both", async () => {
  for (const org of [otherOrg, sandbox]) {
    const rows = await myConsentRecords(session(org, org === sandbox ? "sandbox" : "live"));
    assert.deepEqual(new Set(rows.filter((r) => r.scope_org_id).map((r) => r.record_id)), expected.get(org));
    assert.ok(rows.every((r) => r.scope_org_id === null || r.scope_org_id === org));
  }
  for (const [org, env] of [[live, "sandbox"], [sandbox, "live"], [live, ""], ["", "live"], [live, "invalid"]]) {
    const rows = await raw(user, org, env);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].kind, "terms_privacy");
  }
  assert.deepEqual(await raw("", live, "live"), []);
  await assert.rejects(myConsentRecords({ ...session(), orgId: "" }));
});

test("ID notice evidence selects a complete digest/time pair without mixing modern and legacy acknowledgements", async () => {
  const legacyAt = "2026-10-01T12:00:00.000Z";
  const cases: { name: string; modern: [string | null, string | null]; legacy: [string | null, string | null];
    expected: [string, string] | null }[] = [
    { name: "conflicting complete pairs prefer modern", modern: [digest, at], legacy: [legacyDigest, legacyAt], expected: [digest, at] },
    { name: "modern digest alone falls back to legacy pair", modern: [digest, null], legacy: [legacyDigest, legacyAt], expected: [legacyDigest, legacyAt] },
    { name: "modern time alone falls back to legacy pair", modern: [null, at], legacy: [legacyDigest, legacyAt], expected: [legacyDigest, legacyAt] },
    { name: "modern digest cannot use legacy time", modern: [digest, null], legacy: [null, legacyAt], expected: null },
    { name: "legacy digest cannot use modern time", modern: [null, at], legacy: [legacyDigest, null], expected: null },
    { name: "both digests without times", modern: [digest, null], legacy: [legacyDigest, null], expected: null },
    { name: "both times without digests", modern: [null, at], legacy: [null, legacyAt], expected: null },
    { name: "modern pair with legacy digest only", modern: [digest, at], legacy: [legacyDigest, null], expected: [digest, at] },
    { name: "modern pair with legacy time only", modern: [digest, at], legacy: [null, legacyAt], expected: [digest, at] },
    { name: "blank modern digest falls back", modern: ["   ", at], legacy: [legacyDigest, legacyAt], expected: [legacyDigest, legacyAt] },
    { name: "empty modern digest falls back", modern: ["", at], legacy: [legacyDigest, legacyAt], expected: [legacyDigest, legacyAt] },
    { name: "blank modern and incomplete legacy omitted", modern: ["   ", at], legacy: [legacyDigest, null], expected: null },
    { name: "blank legacy digest omitted", modern: [null, null], legacy: ["   ", legacyAt], expected: null },
    { name: "legacy digest trimmed as a pair", modern: [null, at], legacy: [` ${legacyDigest} `, legacyAt], expected: [legacyDigest, legacyAt] },
    { name: "modern digest trimmed as a pair", modern: [` ${digest} `, at], legacy: [legacyDigest, legacyAt], expected: [digest, at] },
  ];
  await db.query("BEGIN");
  try {
    const fixture = (await db.query(`SELECT d.contact_id, d.lease_id FROM identity_documents d
      JOIN contacts c ON c.id=d.contact_id WHERE c.user_id=$1 AND d.org_id=$2 LIMIT 1`, [user, live])).rows[0];
    const ids = new Map<string, typeof cases[number]>();
    for (const item of cases) {
      const id = randomUUID();
      ids.set(id, item);
      await db.query(`INSERT INTO identity_documents(id,org_id,contact_id,lease_id,doc_type,storage_path,encryption_key_ref,
          number_masked,number_hash,consent_notice_sha,consented_at,consent_notice_sha256,consent_accepted_at,deleted_at)
        VALUES($1,$2,$3,$4,'passport','private/storage/path','private-key','A******001','private-hash',$5,$6,$7,$8,now())`,
      [id, live, fixture.contact_id, fixture.lease_id, ...item.modern, ...item.legacy]);
    }
    await db.query(`SELECT set_config('request.jwt.claim.sub',$1,true),set_config('app.active_org_id',$2,true),set_config('app.env','live',true)`, [user, live]);
    await db.query("SET LOCAL ROLE authenticated");
    const rows = (await db.query("SELECT * FROM app.prop04_my_consent_records() WHERE kind='id_notice'")).rows;
    for (const [id, item] of ids) {
      const matches = rows.filter((row) => row.record_id === id);
      assert.deepEqual(matches.map((row) => [row.document_ref, row.accepted_at.toISOString()]),
        item.expected ? [item.expected] : [], item.name);
    }
  } finally { await db.query("ROLLBACK"); }
});

test("portal contacts retain own ID/signature history without staff membership; partner records require active membership", async () => {
  await db.query(`UPDATE org_members SET status='suspended' WHERE user_id=$1 AND org_id=$2`, [user, live]);
  const rows = await myConsentRecords({ ...session(), kind: "tenant", role: null });
  assert.equal(rows.filter((r) => r.kind.startsWith("partner_")).length, 0);
  assert.equal(rows.filter((r) => r.kind === "id_notice").length, 2);
  assert.equal(rows.filter((r) => r.kind === "lease_signature").length, 2);
});

test("RPC is authenticated-only, SECURITY DEFINER and uses a fixed search_path", async () => {
  const row = (await db.query(`SELECT p.prosecdef, p.proconfig,
    has_function_privilege('authenticated',p.oid,'EXECUTE') AS authenticated,
    has_function_privilege('anon',p.oid,'EXECUTE') AS anon,
    has_function_privilege('service_role',p.oid,'EXECUTE') AS service,
    has_function_privilege('public',p.oid,'EXECUTE') AS public
    FROM pg_proc p WHERE p.oid='app.prop04_my_consent_records()'::regprocedure`)).rows[0];
  assert.deepEqual(row, { prosecdef: true, proconfig: ["search_path=pg_catalog, public, app"], authenticated: true, anon: false, service: false, public: false });
  for (const role of ["anon", "service_role"]) {
    await assert.rejects(raw(user, live, "live", role), (error: unknown) => (error as { code: string }).code === "42501");
  }
});
