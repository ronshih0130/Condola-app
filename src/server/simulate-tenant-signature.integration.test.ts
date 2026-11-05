import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { Client } from "pg";
import { query } from "./db";
import { createProperty, signLease, simulateTenantSignature } from "./domain";
import { FlowError } from "./errors";
import { ORG_ID, USERS } from "./ids";
import { createLeaseFromForm } from "./lease-form";
import { taipeiToday } from "./money";
import { ensureSandbox } from "./sandbox";
import { disposableDbUrl } from "./test-disposable-db";
import { cloneTestDatabase } from "./test-database-clone";
import type { Session } from "./types";

// The clone retains financial history until the entire disposable database is removed.
disposableDbUrl(process.env.DATABASE_URL, process.env.CONDOLA_RLS_DISPOSABLE);
let clone: Awaited<ReturnType<typeof cloneTestDatabase>> | undefined;
test.before(async () => { clone = await cloneTestDatabase(); });
test.after(async () => { await clone?.cleanup(); });

// Executes only against the caller's explicitly provisioned disposable seeded DB.
test("formal simulation denies with durable audit; sandbox simulation records the real staff actor", async () => {
  disposableDbUrl(process.env.DATABASE_URL, process.env.CONDOLA_RLS_DISPOSABLE);
  const sessionId = randomUUID();
  const live: Session = { userId: USERS.admin, sessionId, email: "synthetic@example.invalid", name: "Synthetic staff", kind: "staff", role: "admin", orgId: ORG_ID, liveOrgId: ORG_ID, environment: "live", locale: "zh-TW", calendar: "gregorian", leaseId: null };
  const token = randomUUID();
  await query(`INSERT INTO auth_sessions(id,user_id,token_hash,expires_at) VALUES($1,$2,$3,clock_timestamp()+interval '1 hour')`, [sessionId, USERS.admin, token]);
  {
    const sandboxId = await ensureSandbox(live);
    const sandbox: Session = { ...live, orgId: sandboxId, environment: "sandbox" };
    async function makeLease(session: Session, tag: string, zero = false) {
      const property = await createProperty(session, {
        name: `B001 synthetic ${tag} ${token}`, city: "台北市", district: "大安區", street: `測試路 ${token}`,
        currency: "TWD", ownerMode: "new", ownerName: "Synthetic owner", ownerPhone: "0912000888",
        ownerEmail: `${tag}.${token}@example.invalid`, canViewTenantPhone: false, unitLabel: "1", floor: "1",
        rentalMode: "by_room", rooms: [{ label: "A", roomType: "suite", baseRentMajor: 10000 }],
      });
      const form = new FormData();
      for (const [key, value] of Object.entries({ roomId: property.roomIds[0], tenantName: `Synthetic ${tag}`, tenantPhone: "0912345678", tenantEmail: `tenant.${tag}.${token}@example.invalid`, lineUserId: "", startDate: taipeiToday(), months: "12", rent: zero ? "0" : "10000", depositMonths: zero ? "0" : "2", depositReason: "", dueDay: "5", splitMethod: "even", billTotal: "", usage: "", rate: "", overrideReason: "" })) form.set(key, value);
      const lease = await createLeaseFromForm(session, form);
      return lease;
    }
    const formalLease = await makeLease(live, "formal");
    const sandboxLease = await makeLease(sandbox, "sandbox");
    const facts = async (id: string) => (await query<{ value: unknown }>(`SELECT jsonb_build_object(
      'lease',(SELECT to_jsonb(l) FROM leases l WHERE l.id=$1),
      'signatures',(SELECT coalesce(jsonb_agg(to_jsonb(s) ORDER BY s.id),'[]'::jsonb) FROM lease_signatures s WHERE s.lease_id=$1),
      'events',(SELECT coalesce(jsonb_agg(to_jsonb(e) ORDER BY e.id),'[]'::jsonb) FROM lease_signature_events e JOIN lease_signatures s ON s.id=e.signature_id WHERE s.lease_id=$1),
      'invoices',(SELECT coalesce(jsonb_agg(to_jsonb(i) ORDER BY i.id),'[]'::jsonb) FROM invoices i WHERE i.lease_id=$1),
      'ledger',(SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY t.id),'[]'::jsonb) FROM ledger_transactions t WHERE t.lease_id=$1),
      'entries',(SELECT coalesce(jsonb_agg(to_jsonb(e) ORDER BY e.id),'[]'::jsonb) FROM ledger_entries e WHERE e.lease_id=$1),
      'lines',(SELECT coalesce(jsonb_agg(to_jsonb(il) ORDER BY il.id),'[]'::jsonb) FROM invoice_lines il JOIN invoices i ON i.id=il.invoice_id WHERE i.lease_id=$1),
      'allocations',(SELECT coalesce(jsonb_agg(to_jsonb(a) ORDER BY a.id),'[]'::jsonb) FROM payment_allocations a JOIN invoices i ON i.id=a.invoice_id WHERE i.lease_id=$1),
      'payments',(SELECT coalesce(jsonb_agg(to_jsonb(p) ORDER BY p.id),'[]'::jsonb) FROM payments p WHERE p.lease_id=$1),
      'threads',(SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY t.id),'[]'::jsonb) FROM message_threads t WHERE t.lease_id=$1),
      'deliveries',(SELECT coalesce(jsonb_agg(to_jsonb(d) ORDER BY d.id),'[]'::jsonb) FROM deliveries d JOIN notifications n ON n.id=d.notification_id WHERE n.lease_id=$1),
      'notifications',(SELECT coalesce(jsonb_agg(to_jsonb(n) ORDER BY n.id),'[]'::jsonb) FROM notifications n WHERE n.lease_id=$1)
    ) AS value`, [id])).rows[0].value;
    const rejected = async (fn: () => Promise<unknown>) => assert.rejects(fn, (error: unknown) => error instanceof FlowError);
    const originalFormal = await facts(formalLease.leaseId);
    const beforeAudit = (await query<{ n: number }>(`SELECT count(*)::int AS n FROM audit_log WHERE org_id=$1 AND actor_user_id=$2 AND event_type='tenant_signature_simulation_denied'`, [ORG_ID, USERS.admin])).rows[0].n;
    await rejected(() => simulateTenantSignature(live, formalLease.leaseId));
    assert.deepEqual(await facts(formalLease.leaseId), originalFormal);
    assert.equal((await query<{ n: number }>(`SELECT count(*)::int AS n FROM audit_log WHERE org_id=$1 AND actor_user_id=$2 AND event_type='tenant_signature_simulation_denied'`, [ORG_ID, USERS.admin])).rows[0].n, beforeAudit + 1);
    // A blocked audit cannot be mistaken for a successfully committed denial.
    const auditHolder = new Client({ connectionString: process.env.DATABASE_URL });
    await auditHolder.connect();
    try {
      await auditHolder.query("BEGIN");
      await auditHolder.query("LOCK TABLE audit_log IN ACCESS EXCLUSIVE MODE");
      await assert.rejects(() => simulateTenantSignature(live, formalLease.leaseId), (error: unknown) => error instanceof FlowError && (error.cause as { code?: string })?.code === "55P03");
    } finally {
      await auditHolder.query("ROLLBACK");
      await auditHolder.end();
    }
    assert.deepEqual(await facts(formalLease.leaseId), originalFormal);
    assert.equal((await query<{ n: number }>(`SELECT count(*)::int AS n FROM audit_log WHERE org_id=$1 AND actor_user_id=$2 AND event_type='tenant_signature_simulation_denied'`, [ORG_ID, USERS.admin])).rows[0].n, beforeAudit + 1);
    await rejected(() => simulateTenantSignature(live, sandboxLease.leaseId));
    await rejected(() => simulateTenantSignature({ ...sandbox, role: "manager" }, sandboxLease.leaseId));
    await rejected(() => simulateTenantSignature({ ...sandbox, environment: "live" }, sandboxLease.leaseId));
    await rejected(() => simulateTenantSignature({ ...sandbox, sessionId: randomUUID() }, sandboxLease.leaseId));
    const initial = await facts(sandboxLease.leaseId);
    await rejected(() => simulateTenantSignature(sandbox, sandboxLease.leaseId)); // ID not yet ready
    assert.deepEqual(await facts(sandboxLease.leaseId), initial);
    const party = (await query<{ id: string }>(`SELECT contact_id::text AS id FROM lease_parties WHERE lease_id=$1 AND role='primary'`, [sandboxLease.leaseId])).rows[0];
    const doc = (await query<{ id: string }>(`INSERT INTO identity_documents(org_id,contact_id,lease_id,doc_type,number_masked,storage_path,encryption_key_ref,review_status,created_by) VALUES($1,$2,$3,'passport','A**789',$4,'synthetic','pending_review',$5) RETURNING id::text`, [sandboxId, party.id, sandboxLease.leaseId, `b001/${token}/document`, USERS.admin])).rows[0];
    for (const slot of ["front", "selfie"]) await query(`INSERT INTO identity_document_photos(org_id,document_id,slot,storage_path,mime_type,size_bytes,sha256) VALUES($1,$2,$3,$4,'image/jpeg',4,'synthetic')`, [sandboxId, doc.id, slot, `b001/${token}/${slot}`]);
    const otherContact = (await query<{ id: string }>(`SELECT id::text FROM contacts WHERE org_id=$1 AND id<>$2 ORDER BY id LIMIT 1`, [sandboxId, party.id])).rows[0];
    assert.ok(otherContact);
    await query(`UPDATE lease_signatures SET contact_id=$2 WHERE lease_id=$1 AND signer_role='tenant'`, [sandboxLease.leaseId, otherContact.id]);
    const mismatch = await facts(sandboxLease.leaseId);
    await rejected(() => simulateTenantSignature(sandbox, sandboxLease.leaseId));
    assert.deepEqual(await facts(sandboxLease.leaseId), mismatch);
    await query(`UPDATE lease_signatures SET contact_id=$2 WHERE lease_id=$1 AND signer_role='tenant'`, [sandboxLease.leaseId, party.id]);
    const leaseHolder = new Client({ connectionString: process.env.DATABASE_URL });
    await leaseHolder.connect();
    try {
      await leaseHolder.query("BEGIN");
      await leaseHolder.query(`SELECT id FROM leases WHERE id=$1 FOR UPDATE`, [sandboxLease.leaseId]);
      await assert.rejects(() => simulateTenantSignature(sandbox, sandboxLease.leaseId), (error: unknown) => error instanceof FlowError && (error.cause as { code?: string })?.code === "55P03");
    } finally {
      await leaseHolder.query("ROLLBACK");
      await leaseHolder.end();
    }
    const afterHeldLease = await facts(sandboxLease.leaseId);
    assert.deepEqual(afterHeldLease, initial);
    await query(`UPDATE lease_signatures SET status='declined' WHERE lease_id=$1 AND signer_role='tenant'`, [sandboxLease.leaseId]);
    const declined = await facts(sandboxLease.leaseId);
    await rejected(() => simulateTenantSignature(sandbox, sandboxLease.leaseId));
    assert.deepEqual(await facts(sandboxLease.leaseId), declined);
    await query(`UPDATE lease_signatures SET status='pending' WHERE lease_id=$1 AND signer_role='tenant'`, [sandboxLease.leaseId]);
    await query(`UPDATE auth_sessions SET expires_at=clock_timestamp()-interval '1 second' WHERE id=$1`, [sessionId]);
    await rejected(() => simulateTenantSignature(sandbox, sandboxLease.leaseId));
    await query(`UPDATE auth_sessions SET expires_at=clock_timestamp()+interval '1 hour',revoked_at=clock_timestamp() WHERE id=$1`, [sessionId]);
    await rejected(() => simulateTenantSignature(sandbox, sandboxLease.leaseId));
    await query(`UPDATE auth_sessions SET revoked_at=NULL WHERE id=$1`, [sessionId]);
    const eventsBefore = (await query<{ id: string; actor: string | null; event: string; origin: string | null }>(`SELECT e.id::text,e.actor_user_id::text AS actor,e.event,e.details->>'origin' AS origin FROM lease_signature_events e JOIN lease_signatures s ON s.id=e.signature_id WHERE s.lease_id=$1 AND s.signer_role='tenant' ORDER BY e.id`, [sandboxLease.leaseId])).rows;
    const result = await simulateTenantSignature(sandbox, sandboxLease.leaseId);
    assert.equal(result.esign, "partially_signed");
    const evidence = await query<{ id: string; actor: string | null; event: string; origin: string | null }>(`SELECT e.id::text,e.actor_user_id::text AS actor,e.event,e.details->>'origin' AS origin FROM lease_signature_events e JOIN lease_signatures s ON s.id=e.signature_id WHERE s.lease_id=$1 AND s.signer_role='tenant' ORDER BY e.id`, [sandboxLease.leaseId]);
    assert.deepEqual(evidence.rows.slice(0, eventsBefore.length), eventsBefore);
    assert.equal(evidence.rows.length, eventsBefore.length + 1);
    assert.deepEqual({ ...evidence.rows.at(-1), id: undefined }, { id: undefined, actor: USERS.admin, event: "signed", origin: "sandbox_simulation" });
    const signature = (await query<{ consent: string | null; user_agent: string }>(`SELECT consent_text_key AS consent,user_agent FROM lease_signatures WHERE lease_id=$1 AND signer_role='tenant'`, [sandboxLease.leaseId])).rows[0];
    assert.deepEqual(signature, { consent: null, user_agent: "condola-sandbox-simulation" });
    await rejected(() => simulateTenantSignature(sandbox, sandboxLease.leaseId));
    const complete = await signLease(sandbox, { leaseId: sandboxLease.leaseId, signedName: "Synthetic manager", consent: true });
    assert.equal(complete.esign, "fully_signed");
    assert.ok(complete.invoiceId);
    for (const zero of [false, true]) {
      const last = await makeLease(sandbox, zero ? "last-zero" : "last-positive", zero);
      const primary = (await query<{ id: string }>(`SELECT contact_id::text AS id FROM lease_parties WHERE lease_id=$1 AND role='primary'`, [last.leaseId])).rows[0];
      const lastDoc = (await query<{ id: string }>(`INSERT INTO identity_documents(org_id,contact_id,lease_id,doc_type,number_masked,storage_path,encryption_key_ref,review_status,created_by) VALUES($1,$2,$3,'passport','A**789',$4,'synthetic','pending_review',$5) RETURNING id::text`, [sandboxId, primary.id, last.leaseId, `b001/${token}/${last.leaseId}/document`, USERS.admin])).rows[0];
      for (const slot of ["front", "selfie"]) await query(`INSERT INTO identity_document_photos(org_id,document_id,slot,storage_path,mime_type,size_bytes,sha256) VALUES($1,$2,$3,$4,'image/jpeg',4,'synthetic')`, [sandboxId, lastDoc.id, slot, `b001/${token}/${last.leaseId}/${slot}`]);
      assert.equal((await signLease(sandbox, { leaseId: last.leaseId, signedName: "Synthetic manager", consent: true })).esign, "partially_signed");
      const priorNotice = (await query<{ id: string }>(`SELECT id::text FROM notifications WHERE lease_id=$1 ORDER BY id`, [last.leaseId])).rows;
      const priorAudit = (await query<{ id: string }>(`SELECT id::text FROM audit_log WHERE org_id=$1 AND event_type='notice_not_sent' AND new_row->>'leaseId'=$2 ORDER BY id`, [sandboxId, last.leaseId])).rows;
      const signed = await simulateTenantSignature(sandbox, last.leaseId);
      assert.equal(signed.esign, "fully_signed");
      assert.ok(signed.invoiceId);
      const rows = await query<{ total: string; balance: string; paid: string; status: string; actor: string; transactions: number; entries: number; allocations: number; payments: number }>(`SELECT i.total_minor::text AS total,i.balance_minor::text AS balance,i.paid_minor::text AS paid,i.status::text,i.created_by::text AS actor,
        (SELECT count(*)::int FROM ledger_transactions t WHERE t.lease_id=i.lease_id) AS transactions,
        (SELECT count(*)::int FROM ledger_entries e WHERE e.lease_id=i.lease_id) AS entries,
        (SELECT count(*)::int FROM payment_allocations a WHERE a.invoice_id=i.id) AS allocations,
        (SELECT count(*)::int FROM payments p WHERE p.lease_id=i.lease_id) AS payments
        FROM invoices i WHERE i.id=$1 AND i.lease_id=$2`, [signed.invoiceId, last.leaseId]);
      assert.equal(rows.rows.length, 1);
      assert.deepEqual(rows.rows[0], { total: zero ? "0" : "3000000", balance: zero ? "0" : "3000000", paid: "0", status: "open", actor: USERS.admin, transactions: zero ? 0 : 1, entries: zero ? 0 : 3, allocations: 0, payments: 0 });
      const notices = (await query<{ id: string; event_type: string }>(`SELECT id::text,event_type FROM notifications WHERE lease_id=$1`, [last.leaseId])).rows;
      const audits = (await query<{ id: string }>(`SELECT id::text FROM audit_log WHERE org_id=$1 AND event_type='notice_not_sent' AND new_row->>'leaseId'=$2`, [sandboxId, last.leaseId])).rows;
      assert.ok(priorNotice.every(row => notices.some(current => current.id === row.id)));
      assert.ok(priorAudit.every(row => audits.some(current => current.id === row.id)));
      const added = notices.filter(row => !priorNotice.some(prior => prior.id === row.id));
      assert.equal(added.length, 1);
      assert.equal(added[0].event_type, "rent_due");
      assert.equal(audits.length, priorAudit.length + 1);
      const deliveries = (await query<{ status: string; provider: string }>(`SELECT status::text,provider FROM deliveries WHERE notification_id=$1`, [added[0].id])).rows;
      assert.deepEqual(deliveries, [{ status: "skipped", provider: "sandbox_log" }]);
      await rejected(() => simulateTenantSignature(sandbox, last.leaseId));
      assert.equal((await query<{ n: number }>(`SELECT count(*)::int AS n FROM invoices WHERE lease_id=$1 AND source='move_in'`, [last.leaseId])).rows[0].n, 1);
    }
    for (const phase of ["audit", "notice", "expiry"] as const) {
      const target = await makeLease(sandbox, `rollback-${phase}`);
      const primary = (await query<{ id: string }>(`SELECT contact_id::text AS id FROM lease_parties WHERE lease_id=$1 AND role='primary'`, [target.leaseId])).rows[0];
      const readyDoc = (await query<{ id: string }>(`INSERT INTO identity_documents(org_id,contact_id,lease_id,doc_type,number_masked,storage_path,encryption_key_ref,review_status,created_by) VALUES($1,$2,$3,'passport','A**789',$4,'synthetic','pending_review',$5) RETURNING id::text`, [sandboxId, primary.id, target.leaseId, `b001/${token}/${target.leaseId}/document`, USERS.admin])).rows[0];
      for (const slot of ["front", "selfie"]) await query(`INSERT INTO identity_document_photos(org_id,document_id,slot,storage_path,mime_type,size_bytes,sha256) VALUES($1,$2,$3,$4,'image/jpeg',4,'synthetic')`, [sandboxId, readyDoc.id, slot, `b001/${token}/${target.leaseId}/${slot}`]);
      assert.equal((await signLease(sandbox, { leaseId: target.leaseId, signedName: "Synthetic manager", consent: true })).esign, "partially_signed");
      const before = await facts(target.leaseId);
      const priorRentDue = (await query<{ n: number }>(`SELECT count(*)::int AS n FROM notifications WHERE lease_id=$1 AND event_type='rent_due'`, [target.leaseId])).rows[0].n;
      const auditBeforeFailure = (await query<{ n: number }>(`SELECT count(*)::int AS n FROM audit_log WHERE org_id=$1 AND (new_row->>'leaseId'=$2 OR event_type='tenant_signature_simulated')`, [sandboxId, target.leaseId])).rows[0].n;
      if (phase === "expiry") await query(`UPDATE auth_sessions SET expires_at=clock_timestamp()+interval '2 seconds' WHERE id=$1`, [sessionId]);
      const original = Client.prototype.query;
      const matched = new WeakSet<Client>();
      let injected = false;
      let sessionLiveAtFlush = false;
      try {
        Object.defineProperty(Client.prototype, "query", { configurable: true, writable: true, value: async function(this: Client, ...args: unknown[]) {
          const sql = typeof args[0] === "string" ? args[0] : "";
          const params = Array.isArray(args[1]) ? args[1] as unknown[] : [];
          if (sql.includes("JOIN auth_sessions a") && params[1] === sessionId) matched.add(this);
          if (matched.has(this) && phase === "audit" && sql.includes("INSERT INTO audit_log") && params.includes("tenant_signature_simulated")) {
            const actual = await Reflect.apply(original, this, [`SELECT status::text FROM lease_signatures WHERE lease_id=$1 AND signer_role='tenant'`, [target.leaseId]]) as { rows: { status: string }[] };
            assert.equal(actual.rows[0]?.status, "signed");
            injected = true;
            throw new Error("synthetic audit fault");
          }
          if (matched.has(this) && phase === "notice" && sql.includes("INSERT INTO audit_log") && params.includes("notice_not_sent") && params.some(param => {
            if (typeof param !== "string" || !param.includes(target.leaseId)) return false;
            try {
              JSON.parse(param);
              return true;
            } catch {
              return false;
            }
          })) {
            const actual = await Reflect.apply(original, this, [`SELECT
              (SELECT status::text FROM lease_signatures WHERE lease_id=$1 AND signer_role='tenant') AS signature,
              (SELECT count(*)::int FROM invoices WHERE lease_id=$1 AND source='move_in') AS invoices,
              (SELECT count(*)::int FROM notifications WHERE lease_id=$1 AND event_type='rent_due') AS notices`, [target.leaseId]]) as { rows: { signature: string; invoices: number; notices: number }[] };
            assert.equal(actual.rows[0]?.signature, "signed");
            assert.equal(actual.rows[0]?.invoices, 1);
            assert.equal(actual.rows[0].notices, priorRentDue + 1);
            injected = true;
            throw new Error("synthetic sandbox notice audit fault");
          }
          const result = await Reflect.apply(original, this, args);
          if (matched.has(this) && phase === "expiry" && sql === "SET CONSTRAINTS ALL IMMEDIATE") {
            const liveAtFlush = await Reflect.apply(original, this, [`SELECT expires_at>clock_timestamp() AS live FROM auth_sessions WHERE id=$1`, [sessionId]]) as { rows: { live: boolean }[] };
            sessionLiveAtFlush = liveAtFlush.rows[0]?.live === true;
            injected = true;
            await Reflect.apply(original, this, ["SELECT pg_sleep(2.2)"]);
          }
          return result;
        } });
        await assert.rejects(() => simulateTenantSignature(sandbox, target.leaseId), (error: unknown) => error instanceof FlowError && (phase !== "expiry" || error.key === "errors.notFound"));
      } finally {
        Object.defineProperty(Client.prototype, "query", { configurable: true, writable: true, value: original });
      }
      assert.equal(injected, true);
      if (phase === "expiry") assert.equal(sessionLiveAtFlush, true);
      assert.deepEqual(await facts(target.leaseId), before);
      assert.equal((await query<{ n: number }>(`SELECT count(*)::int AS n FROM audit_log WHERE org_id=$1 AND (new_row->>'leaseId'=$2 OR event_type='tenant_signature_simulated')`, [sandboxId, target.leaseId])).rows[0].n, auditBeforeFailure);
      if (phase === "expiry") await query(`UPDATE auth_sessions SET expires_at=clock_timestamp()+interval '1 hour' WHERE id=$1`, [sessionId]);
    }
  }
});
