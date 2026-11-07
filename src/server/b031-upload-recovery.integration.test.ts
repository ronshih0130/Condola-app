import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import test, { mock } from "node:test";
import { Client, type QueryResult } from "pg";
import { query, tx, withClient } from "./db";
import { createTicket } from "./domain";
import { FlowError } from "./errors";
import { ORG_ID, ORG2_ID, USERS } from "./ids";
import { ticketDetail } from "./queries";
import { PHOTO_BUCKET, ticketPhotoPath } from "./repair-rules";
import { cloneTestDatabase } from "./test-database-clone";
import { insertTestAuthSession } from "./test-auth-session";
import { confirmTicketPhoto, issueUploadGrant } from "./ticket-photos";
import type { Session } from "./types";
import {
  confirmBatchPhoto, discardBatchPhotos, prepareBatchPhoto, submitBatchPhotos, ticketPhotoRecovery, uploadRecoveryEnabled, type UploadStorageDeps,
} from "./upload-recovery";
import { handleUploadBatch } from "./upload-recovery-route";

// B-031 slice 3 UPLOAD_RECOVERY. Local disposable PostgreSQL clone only; storage is an
// in-memory mock (no bucket, no network). All people, files and keys are synthetic.
type QueryFn = (this: Client, sql: string, values?: unknown[]) => Promise<QueryResult>;
const JPEG = Uint8Array.of(0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12);
const PNG = Uint8Array.of(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0, 0, 0, 0, 0);
const environment = ["SUPABASE_URL", "NEXT_PUBLIC_SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY"] as const;
const previous = environment.map((key) => process.env[key]);
let clone: Awaited<ReturnType<typeof cloneTestDatabase>>;
let wangLease = "";
let zhangLease = "";

test.before(async () => {
  clone = await cloneTestDatabase(); // Validates local host + explicit disposable consent before access.
  delete process.env.SUPABASE_URL;
  delete process.env.NEXT_PUBLIC_SUPABASE_URL;
  process.env.SUPABASE_SERVICE_ROLE_KEY = "synthetic-local-grant-key"; // HMAC grant key for the existing path only.
  wangLease = await leaseFor(USERS.tenant2);
  zhangLease = await leaseFor(USERS.tenant);
});
test.after(async () => {
  mock.restoreAll();
  for (const [index, key] of environment.entries()) {
    if (previous[index] === undefined) delete process.env[key];
    else process.env[key] = previous[index];
  }
  await clone?.cleanup();
});
test.afterEach(() => mock.restoreAll());

async function leaseFor(userId: string) {
  const row = await query<{ id: string }>(`SELECT l.id::text FROM leases l JOIN lease_parties lp ON lp.lease_id = l.id
    JOIN contacts c ON c.id = lp.contact_id WHERE c.user_id = $1 AND l.org_id = $2 AND l.status = 'active' ORDER BY l.created_at LIMIT 1`, [userId, ORG_ID]);
  assert.ok(row.rows[0]);
  return row.rows[0].id;
}

async function session(userId: string, kind: "staff" | "tenant", role: Session["role"], orgId = ORG_ID): Promise<Session> {
  const sessionId = await withClient((c) => insertTestAuthSession(c, userId));
  return { userId, sessionId, orgId, liveOrgId: orgId, kind, role, environment: "live", locale: "en", calendar: "gregorian",
    leaseId: null, email: "synthetic@example.test", name: "Synthetic" };
}

async function flag(value: unknown, orgFlag: unknown = true) {
  await query(`INSERT INTO platform_settings(key, value) VALUES ('upload_recovery', $1::jsonb)
    ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`, [JSON.stringify(value)]);
  await query(`UPDATE organizations SET feature_flags = jsonb_set(feature_flags, '{upload_recovery}', $2::jsonb, true) WHERE id = $1`,
    [ORG_ID, JSON.stringify(orgFlag)]);
}
const enable = () => flag({ enabled: true, allowed_org_ids: [ORG_ID] });
async function disable() {
  await query(`UPDATE platform_settings SET value = '{"enabled":false,"allowed_org_ids":[]}' WHERE key = 'upload_recovery'`);
  await query(`UPDATE organizations SET feature_flags = feature_flags - 'upload_recovery' WHERE id = $1`, [ORG_ID]);
}

/** In-memory object store with the same probe/sign/header/remove surface as ticket-photos. */
function mockStorage() {
  const objects = new Map<string, { bytes: Uint8Array; mime: string }>();
  const calls = { sign: 0, put: 0, remove: 0 };
  const deps: UploadStorageDeps = {
    info: async (path) => { const o = objects.get(path); return o ? { ok: true, size: o.bytes.length, mime: o.mime } : { ok: false }; },
    header: async (path) => objects.get(path)!.bytes.slice(0, 16),
    sign: async (path) => { calls.sign += 1; return { token: "synthetic", uploadUrl: `mock-storage:${path}` }; },
    remove: async (path) => { calls.remove += 1; objects.delete(path); },
  };
  const put = (uploadUrl: string, bytes: Uint8Array, mime: string) => {
    calls.put += 1;
    const path = uploadUrl.replace(/^mock-storage:/, "");
    if (objects.has(path)) throw new Error("object exists"); // Signed uploads never overwrite.
    objects.set(path, { bytes, mime });
  };
  return { objects, calls, deps, put };
}
type Storage = ReturnType<typeof mockStorage>;

/** What the browser component does for one file; failPut simulates a lost network on the PUT. */
async function sendFile(s: Session, storage: Storage, ticketId: string, batchKey: string, clientKey: string, name: string,
  options: { failPut?: boolean; bytes?: Uint8Array; mime?: string; internal?: boolean } = {}) {
  const bytes = options.bytes ?? JPEG, mime = options.mime ?? "image/jpeg";
  const prepared = await prepareBatchPhoto(s, { ticketId, batchKey, clientKey, fileName: name, mime, size: bytes.length,
    internal: options.internal ?? false }, storage.deps);
  if (prepared.state === "uploaded" || prepared.state === "attached" || prepared.state === "closed") return prepared.state;
  if (prepared.state === "signed") {
    if (options.failPut) return "failed";
    storage.put(prepared.uploadUrl, bytes, mime);
  }
  return (await confirmBatchPhoto(s, { ticketId, batchKey, clientKey }, storage.deps)).state;
}

async function ticket(s: Session, lease: string) {
  return createTicket(s, { leaseId: lease, category: "plumbing", title: `B031 upload ${randomUUID()}`, description: "Synthetic leak" });
}
async function counts(ticketId: string) {
  const r = await query<{ attachments: number; files: number; items: number; batches: number }>(`SELECT
    (SELECT count(*)::int FROM ticket_attachments WHERE ticket_id = $1) AS attachments,
    (SELECT count(*)::int FROM files f WHERE f.storage_bucket = $2 AND f.storage_path LIKE '%/tickets/' || $1 || '/%') AS files,
    (SELECT count(*)::int FROM app.b031_upload_items i JOIN app.b031_upload_batches b ON b.id = i.batch_id WHERE b.ticket_id = $1) AS items,
    (SELECT count(*)::int FROM app.b031_upload_batches WHERE ticket_id = $1) AS batches`, [ticketId, PHOTO_BUCKET]);
  return r.rows[0];
}
async function itemPath(ticketId: string, clientKey: string) {
  const r = await query<{ storage_path: string; state: string }>(`SELECT i.storage_path, i.state FROM app.b031_upload_items i
    JOIN app.b031_upload_batches b ON b.id = i.batch_id WHERE b.ticket_id = $1 AND i.client_key = $2`, [ticketId, clientKey]);
  return r.rows;
}
const rejectsWith = (key: string) => (error: unknown) => error instanceof FlowError && error.key === key;
const denied = (error: unknown) => error instanceof FlowError && (error.key === "errors.forbidden" || error.key === "errors.notFound");

async function waitForLockWaiters(observer: Client, n: number) {
  for (let i = 0; i < 200; i += 1) {
    const r = await observer.query<{ n: number }>(`SELECT count(*)::int AS n FROM pg_stat_activity
      WHERE datname = current_database() AND wait_event_type = 'Lock' AND query LIKE '%b031_upload%'`);
    if (r.rows[0].n >= n) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.fail(`expected ${n} lock waiters`);
}

test("partial failure: 3 files, #2 fails, retry #2 only -> exactly 3 attached, no duplicates, idempotent submit", async () => {
  await enable();
  const wang = await session(USERS.tenant2, "tenant", null);
  const ticketId = await ticket(wang, wangLease);
  const storage = mockStorage();
  const batch = randomUUID(), keys = [randomUUID(), randomUUID(), randomUUID()];
  assert.equal(await sendFile(wang, storage, ticketId, batch, keys[0], "one.jpg"), "uploaded");
  assert.equal(await sendFile(wang, storage, ticketId, batch, keys[1], "two.jpg", { failPut: true }), "failed");
  assert.equal(await sendFile(wang, storage, ticketId, batch, keys[2], "three.jpg"), "uploaded");
  const failedPath = (await itemPath(ticketId, keys[1]))[0];
  assert.equal(failedPath.state, "signed");
  // Confirm before the object exists only reports missing; nothing is marked or attached.
  assert.equal((await confirmBatchPhoto(wang, { ticketId, batchKey: batch, clientKey: keys[1] }, storage.deps)).state, "missing");
  assert.deepEqual(await counts(ticketId), { attachments: 0, files: 0, items: 3, batches: 1 });

  // Draft survives: page reload restores the two successes and the failed key.
  const view = await ticketPhotoRecovery(wang, ticketId);
  assert.ok(view?.draft);
  assert.equal(view.draft.batchKey, batch);
  assert.deepEqual(view.draft.items.map((i) => [i.clientKey, i.state]), [[keys[0], "uploaded"], [keys[1], "signed"], [keys[2], "uploaded"]]);

  // Replay of an already-succeeded file is a no-op: no sign, no PUT, no new row.
  const before = { ...storage.calls };
  assert.equal(await sendFile(wang, storage, ticketId, batch, keys[0], "one.jpg"), "uploaded");
  assert.deepEqual(storage.calls, before);
  // Retry the failed file alone, same key -> same reserved path.
  assert.equal(await sendFile(wang, storage, ticketId, batch, keys[1], "two.jpg"), "uploaded");
  assert.deepEqual(await itemPath(ticketId, keys[1]), [{ storage_path: failedPath.storage_path, state: "uploaded" }]);
  assert.equal(storage.objects.size, 3);

  const submitted = await submitBatchPhotos(wang, { ticketId, batchKey: batch, internal: false });
  assert.equal(submitted.attached.length, 3);
  assert.equal(new Set(submitted.attached).size, 3);
  assert.deepEqual(await counts(ticketId), { attachments: 3, files: 3, items: 3, batches: 1 });
  const detail = await ticketDetail(wang, ticketId);
  assert.deepEqual(detail?.photos.map((p) => p.name).sort(), ["one.jpg", "three.jpg", "two.jpg"]);

  // Final submit is idempotent; replays after submit report attached; new files are refused.
  assert.deepEqual(await submitBatchPhotos(wang, { ticketId, batchKey: batch, internal: false }), submitted);
  assert.equal(await sendFile(wang, storage, ticketId, batch, keys[2], "three.jpg"), "attached");
  assert.equal(await sendFile(wang, storage, ticketId, batch, randomUUID(), "late.jpg"), "closed"); // Client starts a new draft.
  assert.deepEqual(await counts(ticketId), { attachments: 3, files: 3, items: 3, batches: 1 });
  assert.equal((await ticketPhotoRecovery(wang, ticketId))?.draft, null);
});

test("lost response after PUT: retry sees the stored object, confirms without a second upload", async () => {
  await enable();
  const wang = await session(USERS.tenant2, "tenant", null);
  const ticketId = await ticket(wang, wangLease);
  const storage = mockStorage();
  const batch = randomUUID(), key = randomUUID();
  const first = await prepareBatchPhoto(wang, { ticketId, batchKey: batch, clientKey: key, fileName: "a.jpg", mime: "image/jpeg", size: JPEG.length, internal: false }, storage.deps);
  assert.equal(first.state, "signed");
  if (first.state === "signed") storage.put(first.uploadUrl, JPEG, "image/jpeg"); // ...the browser never hears back.
  const again = await prepareBatchPhoto(wang, { ticketId, batchKey: batch, clientKey: key, fileName: "a.jpg", mime: "image/jpeg", size: JPEG.length, internal: false }, storage.deps);
  assert.deepEqual(again, { state: "stored" });
  assert.equal(storage.calls.sign, 1);
  assert.equal((await confirmBatchPhoto(wang, { ticketId, batchKey: batch, clientKey: key }, storage.deps)).state, "uploaded");
  assert.equal((await confirmBatchPhoto(wang, { ticketId, batchKey: batch, clientKey: key }, storage.deps)).state, "uploaded");
  assert.equal(storage.calls.put, 1);
  assert.equal((await submitBatchPhotos(wang, { ticketId, batchKey: batch, internal: false })).attached.length, 1);
  assert.deepEqual(await counts(ticketId), { attachments: 1, files: 1, items: 1, batches: 1 });
});

test("disconnect between storage write and DB row: the orphan is recorded, never attached, and adopted by the retry", async () => {
  await enable();
  const wang = await session(USERS.tenant2, "tenant", null);
  const ticketId = await ticket(wang, wangLease);
  const storage = mockStorage();
  const batch = randomUUID(), key = randomUUID();
  const original = Client.prototype.query as unknown as QueryFn;
  let injected = 0;
  mock.method(Client.prototype, "query", (async function (this: Client, sql: string, values?: unknown[]) {
    if (typeof sql === "string" && sql.includes("b031_upload_mark_uploaded")) { injected += 1; throw new Error("Connection terminated unexpectedly"); }
    return original.call(this, sql, values);
  }) as unknown as typeof Client.prototype.query);
  await assert.rejects(sendFile(wang, storage, ticketId, batch, key, "orphan.jpg"));
  mock.restoreAll();
  assert.equal(injected, 1);
  // The object is in storage but no files/ticket_attachments row exists; the item row still names the path.
  assert.equal(storage.objects.size, 1);
  const [orphan] = await itemPath(ticketId, key);
  assert.equal(orphan.state, "signed");
  assert.ok(storage.objects.has(orphan.storage_path));
  await assert.rejects(submitBatchPhotos(wang, { ticketId, batchKey: batch, internal: false }), rejectsWith("errors.required"));
  assert.deepEqual(await counts(ticketId), { attachments: 0, files: 0, items: 1, batches: 1 });
  // Retry with the same key adopts the stored object: no new sign, no second object.
  assert.equal(await sendFile(wang, storage, ticketId, batch, key, "orphan.jpg"), "uploaded");
  assert.equal(storage.calls.sign, 1);
  assert.equal(storage.objects.size, 1);
  assert.equal((await submitBatchPhotos(wang, { ticketId, batchKey: batch, internal: false })).attached.length, 1);
  assert.deepEqual(await counts(ticketId), { attachments: 1, files: 1, items: 1, batches: 1 });

  // A rejected object (wrong signature) under a reserved, unattached path is removed and not marked.
  const bad = randomUUID(), badBatch = randomUUID();
  await assert.rejects(sendFile(wang, storage, ticketId, badBatch, bad, "fake.jpg", { bytes: PNG, mime: "image/jpeg" }), rejectsWith("errors.photoType"));
  assert.equal(storage.calls.remove, 1);
  assert.equal((await itemPath(ticketId, bad))[0].state, "signed");
});

test("concurrent duplicate submissions on two connections yield one item row and one attachment set", async () => {
  await enable();
  const admin = await session(USERS.admin, "staff", "admin");
  const zhang = await session(USERS.tenant, "tenant", null);
  const ticketId = await ticket(zhang, zhangLease);
  const storage = mockStorage();
  const batch = randomUUID(), key = randomUUID();
  // Create the draft, then hold its row lock so both duplicates queue behind it.
  assert.equal(await sendFile(admin, storage, ticketId, batch, randomUUID(), "first.jpg", { internal: true }), "uploaded");
  const blocker = new Client({ connectionString: process.env.DATABASE_URL }), observer = new Client({ connectionString: process.env.DATABASE_URL });
  await blocker.connect(); await observer.connect();
  try {
    await blocker.query("BEGIN");
    await blocker.query(`SELECT 1 FROM app.b031_upload_batches WHERE client_batch_key = $1 FOR UPDATE`, [batch]);
    const input = { ticketId, batchKey: batch, clientKey: key, fileName: "dup.jpg", mime: "image/jpeg", size: JPEG.length, internal: true };
    const racing = [prepareBatchPhoto(admin, input, storage.deps), prepareBatchPhoto(admin, input, storage.deps)];
    await waitForLockWaiters(observer, 2);
    await blocker.query("COMMIT");
    const results = await Promise.all(racing);
    assert.deepEqual(results.map((r) => r.state), ["signed", "signed"]);
    assert.equal((await itemPath(ticketId, key)).length, 1);
    const first = results[0];
    if (first.state === "signed") storage.put(first.uploadUrl, JPEG, "image/jpeg");
    assert.equal((await confirmBatchPhoto(admin, { ticketId, batchKey: batch, clientKey: key }, storage.deps)).state, "uploaded");

    // DB uniqueness, not only TS: a second row for the same (org, batch, client key) is impossible.
    await assert.rejects(query(`INSERT INTO app.b031_upload_items(org_id, batch_id, client_key, storage_path, file_name, mime_type, size_bytes)
      SELECT i.org_id, i.batch_id, i.client_key, i.storage_path || '.x', 'x.jpg', 'image/jpeg', 1 FROM app.b031_upload_items i WHERE i.client_key = $1`, [key]),
      /b031_upload_items_org_id_batch_id_client_key_key/);

    // Two concurrent final submits: one attaches, the other replays the same ids.
    await blocker.query("BEGIN");
    await blocker.query(`SELECT 1 FROM app.b031_upload_batches WHERE client_batch_key = $1 FOR UPDATE`, [batch]);
    const submits = [submitBatchPhotos(admin, { ticketId, batchKey: batch, internal: true }), submitBatchPhotos(admin, { ticketId, batchKey: batch, internal: true })];
    await waitForLockWaiters(observer, 2);
    await blocker.query("COMMIT");
    const [a, b] = await Promise.all(submits);
    assert.deepEqual(a, b);
    assert.equal(a.attached.length, 2);
    assert.deepEqual(await counts(ticketId), { attachments: 2, files: 2, items: 2, batches: 1 });
    // Internal draft field applied; existing tenant RLS still hides internal photos (no widening).
    const internal = await query<{ n: number }>(`SELECT count(*)::int AS n FROM ticket_attachments WHERE ticket_id = $1 AND is_internal`, [ticketId]);
    assert.equal(internal.rows[0].n, 2);
    assert.equal((await ticketDetail(zhang, ticketId))?.photos.length, 0);
    const seen = await tx(USERS.tenant, (c) => c.query(`SELECT f.id FROM files f JOIN ticket_attachments a ON a.file_id = f.id WHERE a.ticket_id = $1`, [ticketId]), { orgId: ORG_ID });
    assert.equal(seen.rowCount, 0);
  } finally {
    await blocker.query("ROLLBACK").catch(() => {});
    await blocker.end(); await observer.end();
  }
});

test("another user or org cannot read, attach or replay someone else's batch (API role, not superuser)", async () => {
  await enable();
  const wang = await session(USERS.tenant2, "tenant", null);
  const zhang = await session(USERS.tenant, "tenant", null);
  const admin = await session(USERS.admin, "staff", "admin");
  const accountant = await session(USERS.accountant, "staff", "accountant");
  const coast = await session(USERS.coastAdmin, "staff", "admin", ORG2_ID);
  const ticketId = await ticket(wang, wangLease);
  const storage = mockStorage();
  const batch = randomUUID(), key = randomUUID(), other = randomUUID();
  assert.equal(await sendFile(wang, storage, ticketId, batch, key, "mine.jpg"), "uploaded");
  assert.equal(await sendFile(wang, storage, ticketId, batch, other, "pending.jpg", { failPut: true }), "failed");
  const snapshot = await counts(ticketId);

  // Service layer: other tenant cannot see the ticket; same-org staff and other-org admin cannot address the batch.
  await assert.rejects(sendFile(zhang, storage, ticketId, batch, other, "steal.jpg"), denied);
  await assert.rejects(confirmBatchPhoto(zhang, { ticketId, batchKey: batch, clientKey: key }, storage.deps), denied);
  await assert.rejects(submitBatchPhotos(zhang, { ticketId, batchKey: batch, internal: false }), denied);
  await assert.rejects(confirmBatchPhoto(admin, { ticketId, batchKey: batch, clientKey: key }, storage.deps), denied);
  await assert.rejects(submitBatchPhotos(admin, { ticketId, batchKey: batch, internal: false }), denied);
  await assert.rejects(sendFile(accountant, storage, ticketId, batch, randomUUID(), "acct.jpg"), denied);
  await assert.rejects(sendFile(wang, storage, ticketId, batch, randomUUID(), "secret.jpg", { internal: true }), denied);
  await assert.rejects(submitBatchPhotos(coast, { ticketId, batchKey: batch, internal: false }), denied);
  assert.equal((await ticketPhotoRecovery(admin, ticketId))?.draft, null); // Admin has no draft of its own here.
  assert.equal((await ticketPhotoRecovery(zhang, ticketId))?.draft, null);

  // SQL gateways as `authenticated` with each caller's own JWT subject and pinned org.
  const sqlDenied = rejectsWith("errors.forbidden"); // tx maps 42501 / permission denied to errors.forbidden.
  const asUser = (userId: string, orgId: string, sql: string, values: unknown[]) => tx(userId, (c) => c.query(sql, values), { orgId });
  for (const [userId, orgId] of [[USERS.tenant, ORG_ID], [USERS.admin, ORG_ID], [USERS.coastAdmin, ORG2_ID], [USERS.coastAdmin, ORG_ID]] as const) {
    await assert.rejects(asUser(userId, orgId, `SELECT * FROM app.b031_upload_items_for($1, $2)`, [ORG_ID, batch]), sqlDenied);
    await assert.rejects(asUser(userId, orgId, `SELECT app.b031_upload_mark_uploaded($1, $2, $3, 'image/jpeg', 16)`, [ORG_ID, batch, other]), sqlDenied);
    await assert.rejects(asUser(userId, orgId, `SELECT app.b031_upload_lock_batch($1, $2, false)`, [ORG_ID, batch]), sqlDenied);
    await assert.rejects(asUser(userId, orgId, `SELECT * FROM app.b031_upload_reserve($1, $2, $3, $4, 'x.jpg', 'image/jpeg', 16)`,
      [ORG_ID, batch, randomUUID(), ticketPhotoPath(ORG_ID, ticketId, randomUUID(), "image/jpeg")]), sqlDenied);
    await assert.rejects(asUser(userId, orgId, `SELECT app.b031_upload_close_batch($1, $2, true)`, [ORG_ID, batch]), sqlDenied);
    await assert.rejects(asUser(userId, orgId, `SELECT app.b031_upload_discard_item($1, $2, $3)`, [ORG_ID, batch, other]), sqlDenied);
  }
  // The same key under another owner is a different (new) draft, never the victim's.
  await asUser(USERS.admin, ORG_ID, `SELECT app.b031_upload_open_batch($1, $2, $3, false)`, [ORG_ID, ticketId, batch]);
  const adminItems = await asUser(USERS.admin, ORG_ID, `SELECT * FROM app.b031_upload_items_for($1, $2)`, [ORG_ID, batch]);
  assert.equal(adminItems.rowCount, 0);
  // Other-org admin cannot open a batch on this org's ticket; accountant/tenant cannot stage internal photos.
  await assert.rejects(asUser(USERS.coastAdmin, ORG2_ID, `SELECT app.b031_upload_open_batch($1, $2, $3, false)`, [ORG_ID, ticketId, randomUUID()]), sqlDenied);
  await assert.rejects(asUser(USERS.accountant, ORG_ID, `SELECT app.b031_upload_open_batch($1, $2, $3, false)`, [ORG_ID, ticketId, randomUUID()]), sqlDenied);
  await assert.rejects(asUser(USERS.tenant2, ORG_ID, `SELECT app.b031_upload_open_batch($1, $2, $3, true)`, [ORG_ID, ticketId, randomUUID()]), sqlDenied);
  // Attach marker cannot point at someone else's attachment or skip the RLS insert.
  const foreign = await query<{ id: string }>(`SELECT id::text FROM ticket_attachments LIMIT 1`);
  if (foreign.rows[0]) {
    await assert.rejects(asUser(USERS.tenant2, ORG_ID, `SELECT app.b031_upload_mark_attached($1, $2, $3, $4)`, [ORG_ID, batch, key, foreign.rows[0].id]), sqlDenied);
  }
  // No direct table access for API roles; no execute for anon/service_role on the gateways.
  for (const table of ["app.b031_upload_batches", "app.b031_upload_items"]) {
    await assert.rejects(asUser(USERS.tenant2, ORG_ID, `SELECT * FROM ${table}`, []), sqlDenied);
  }
  const grants = await query<{ role: string; fn: string; ok: boolean }>(`SELECT r.rolname AS role, p.oid::regprocedure::text AS fn,
      has_function_privilege(r.rolname, p.oid, 'EXECUTE') AS ok
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace CROSS JOIN pg_roles r
    WHERE n.nspname = 'app' AND p.proname LIKE 'b031_upload%' AND r.rolname IN ('anon', 'authenticated', 'service_role')`);
  const executable = grants.rows.filter((g) => g.ok).map((g) => `${g.role}:${g.fn.replace(/\(.*/, "")}`).sort();
  assert.deepEqual(executable, [
    "authenticated:app.b031_upload_close_batch", "authenticated:app.b031_upload_discard_item", "authenticated:app.b031_upload_items_for", "authenticated:app.b031_upload_lock_batch",
    "authenticated:app.b031_upload_mark_attached", "authenticated:app.b031_upload_mark_uploaded", "authenticated:app.b031_upload_open_batch",
    "authenticated:app.b031_upload_open_draft", "authenticated:app.b031_upload_reserve", "service_role:app.b031_upload_recovery_on",
  ]);
  const definers = await query<{ n: number }>(`SELECT count(*)::int AS n FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'app' AND p.proname LIKE 'b031_upload%' AND (NOT p.prosecdef OR NOT 'search_path=pg_catalog, pg_temp' = ANY(p.proconfig))`);
  assert.equal(definers.rows[0].n, 0);

  // The victim's draft is untouched; the owner can still finish it.
  assert.deepEqual((await counts(ticketId)).attachments, snapshot.attachments);
  assert.equal((await submitBatchPhotos(wang, { ticketId, batchKey: batch, internal: false })).attached.length, 1);
});

test("a failed final submit keeps the draft (non-file field + uploaded files); the retry attaches them once", async () => {
  await enable();
  const admin = await session(USERS.maintenance, "staff", "maintenance");
  const zhang = await session(USERS.tenant, "tenant", null);
  const ticketId = await ticket(zhang, zhangLease);
  const storage = mockStorage();
  const batch = randomUUID();
  for (const name of ["a.jpg", "b.jpg"]) assert.equal(await sendFile(admin, storage, ticketId, batch, randomUUID(), name, { internal: true }), "uploaded");
  const original = Client.prototype.query as unknown as QueryFn;
  let seen = 0;
  mock.method(Client.prototype, "query", (async function (this: Client, sql: string, values?: unknown[]) {
    if (typeof sql === "string" && sql.includes("INSERT INTO ticket_attachments") && ++seen === 2) throw new Error("Connection terminated unexpectedly");
    return original.call(this, sql, values);
  }) as unknown as typeof Client.prototype.query);
  await assert.rejects(submitBatchPhotos(admin, { ticketId, batchKey: batch, internal: true }));
  mock.restoreAll();
  assert.deepEqual(await counts(ticketId), { attachments: 0, files: 0, items: 2, batches: 1 });
  const view = await ticketPhotoRecovery(admin, ticketId);
  assert.equal(view?.draft?.internal, true);
  assert.deepEqual(view?.draft?.items.map((i) => i.state), ["uploaded", "uploaded"]);
  const done = await submitBatchPhotos(admin, { ticketId, batchKey: batch, internal: true });
  assert.equal(done.attached.length, 2);
  assert.deepEqual(await counts(ticketId), { attachments: 2, files: 2, items: 2, batches: 1 });

  // Photo limit counts attachments plus open draft items (8 per ticket).
  const more = randomUUID();
  for (let i = 0; i < 6; i += 1) assert.equal(await sendFile(admin, storage, ticketId, more, randomUUID(), `m${i}.jpg`), "uploaded");
  await assert.rejects(sendFile(admin, storage, ticketId, more, randomUUID(), "ninth.jpg"), rejectsWith("errors.photoLimit"));
});

const OFF_TRACE = new URL("./fixtures/b031-upload-off-sql.json", import.meta.url);
const FLAG_READ = "SELECT app.b031_upload_recovery_on($1::uuid) AS enabled";

async function traced<T>(run: () => Promise<T>) {
  const statements: string[] = [];
  const original = Client.prototype.query as unknown as QueryFn;
  mock.method(Client.prototype, "query", (async function (this: Client, sql: string, values?: unknown[]) {
    assert.equal(typeof sql, "string", "trace must capture every statement");
    statements.push(sql);
    return original.call(this, sql, values);
  }) as unknown as typeof Client.prototype.query);
  try {
    return { statements, result: await run().catch((error: unknown) => error) };
  } finally {
    mock.restoreAll();
  }
}

test("flag OFF: one flag read, zero writes, existing photo path SQL unchanged; malformed flags stay OFF", async () => {
  await disable();
  const wang = await session(USERS.tenant2, "tenant", null);
  const ticketId = await ticket(wang, wangLease);
  const storage = mockStorage();
  const before = await query<{ n: number }>(`SELECT (SELECT count(*) FROM app.b031_upload_batches) + (SELECT count(*) FROM app.b031_upload_items)
    + (SELECT count(*) FROM files) + (SELECT count(*) FROM ticket_attachments) AS n`);
  const batch = randomUUID(), key = randomUUID();
  const offCalls: [string, () => Promise<unknown>][] = [
    ["view", () => ticketPhotoRecovery(wang, ticketId)],
    ["prepare", () => prepareBatchPhoto(wang, { ticketId, batchKey: batch, clientKey: key, fileName: "x.jpg", mime: "image/jpeg", size: 16, internal: false }, storage.deps)],
    ["confirm", () => confirmBatchPhoto(wang, { ticketId, batchKey: batch, clientKey: key }, storage.deps)],
    ["submit", () => submitBatchPhotos(wang, { ticketId, batchKey: batch, internal: false })],
    ["discard", () => discardBatchPhotos(wang, { ticketId, batchKey: batch })],
    ["remove", () => discardBatchPhotos(wang, { ticketId, batchKey: batch, clientKey: key })],
  ];
  for (const [name, run] of offCalls) {
    const { statements, result } = await traced(run);
    assert.deepEqual(statements, [FLAG_READ], name);
    if (name === "view") assert.equal(result, null);
    else assert.ok(result instanceof FlowError && result.key === "errors.notFound", name);
  }
  assert.deepEqual(storage.calls, { sign: 0, put: 0, remove: 0 });
  const after = await query<{ n: number }>(`SELECT (SELECT count(*) FROM app.b031_upload_batches) + (SELECT count(*) FROM app.b031_upload_items)
    + (SELECT count(*) FROM files) + (SELECT count(*) FROM ticket_attachments) AS n`);
  assert.deepEqual(after.rows, before.rows);
  // SQL gateways refuse while OFF even when called directly.
  await assert.rejects(tx(USERS.tenant2, (c) => c.query(`SELECT app.b031_upload_open_batch($1, $2, $3, false)`, [ORG_ID, ticketId, batch]), { orgId: ORG_ID }), rejectsWith("errors.forbidden"));

  // Strict shape: anything but enabled === true + allowlisted org + org flag === true is OFF.
  const shapes: [unknown, unknown][] = [
    [{ enabled: "true", allowed_org_ids: [ORG_ID] }, true], [{ enabled: true }, true], [{ enabled: true, allowed_org_ids: [] }, true],
    [{ enabled: true, allowed_org_ids: ORG_ID }, true], [{ enabled: true, allowed_org_ids: [ORG2_ID] }, true], [true, true],
    [{ enabled: true, allowed_org_ids: [ORG_ID] }, "true"], [{ enabled: true, allowed_org_ids: [ORG_ID] }, false], [{ enabled: true, allowed_org_ids: [ORG_ID] }, null],
  ];
  for (const [value, orgFlag] of shapes) {
    await flag(value, orgFlag);
    assert.equal(await uploadRecoveryEnabled(ORG_ID), false, JSON.stringify([value, orgFlag]));
  }
  await enable();
  assert.equal(await uploadRecoveryEnabled(ORG_ID), true);
  assert.equal(await uploadRecoveryEnabled(ORG2_ID), false);

  // The existing single-photo confirm path (unchanged code) issues the same SQL OFF and ON.
  const traces: Record<string, string[]> = {};
  for (const mode of ["off", "on"] as const) {
    if (mode === "off") await disable(); else await enable();
    const path = ticketPhotoPath(ORG_ID, ticketId, randomUUID(), "image/jpeg");
    const { statements, result } = await traced(() => confirmTicketPhoto(wang, {
      ticketId, path, fileName: `legacy-${mode}.jpg`, mime: "image/jpeg", size: JPEG.length, internal: false,
      uploadToken: issueUploadGrant(wang.userId, ticketId, path),
    }, { info: async () => ({ ok: true, size: JPEG.length, mime: "image/jpeg" }), header: async () => JPEG }));
    assert.equal(typeof result, "string", `legacy confirm ${mode}`);
    traces[`confirm-${mode}`] = statements;
    traces[`detail-${mode}`] = (await traced(() => ticketDetail(wang, ticketId))).statements;
  }
  assert.deepEqual(traces["confirm-on"], traces["confirm-off"]);
  assert.deepEqual(traces["detail-on"], traces["detail-off"]);
  const baseline = { "ticket-photo-confirm": traces["confirm-off"], "ticket-detail": traces["detail-off"] };
  if (process.env.B031_UPLOAD_RECORD_TRACE === "1") writeFileSync(OFF_TRACE, `${JSON.stringify(baseline, null, 2)}\n`);
  assert.deepEqual(baseline, JSON.parse(readFileSync(OFF_TRACE, "utf8")));
  assert.equal((await counts(ticketId)).items, 0);
  await disable();
});

// ---- Fix round 1 regressions (independent review M1, MINOR 1-5) ----

async function attachedCount(ticketId: string) {
  return (await query<{ n: number }>(`SELECT count(*)::int AS n FROM ticket_attachments WHERE ticket_id = $1`, [ticketId])).rows[0].n;
}
async function uploadAll(s: Session, storage: Storage, ticketId: string, batch: string, n: number) {
  const keys: string[] = [];
  for (let i = 0; i < n; i += 1) { const k = randomUUID(); keys.push(k); assert.equal(await sendFile(s, storage, ticketId, batch, k, `f${i}.jpg`), "uploaded"); }
  return keys;
}

test("M1 repro A: 6 photos, 2 lost PUTs, reload -> re-choosing works, submit attaches, draft no longer restored", async () => {
  await enable();
  const wang = await session(USERS.tenant2, "tenant", null);
  const ticketId = await ticket(wang, wangLease);
  const storage = mockStorage();
  const b1 = randomUUID();
  await uploadAll(wang, storage, ticketId, b1, 6);
  await submitBatchPhotos(wang, { ticketId, batchKey: b1, internal: false }, storage.deps);
  const b2 = randomUUID();
  assert.equal(await sendFile(wang, storage, ticketId, b2, randomUUID(), "x.jpg", { failPut: true }), "failed");
  assert.equal(await sendFile(wang, storage, ticketId, b2, randomUUID(), "y.jpg", { failPut: true }), "failed");
  const view = await ticketPhotoRecovery(wang, ticketId, storage.deps);
  assert.deepEqual(view?.draft?.items.map((i) => i.state), ["signed", "signed"]); // Nothing kept -> no "kept" copy (UI test).
  assert.equal(view?.draft?.batchKey, b2);
  // Re-choosing creates new keys in the restored draft; reserved-but-unconfirmed paths hold no photo slot.
  assert.equal(await sendFile(wang, storage, ticketId, b2, randomUUID(), "x.jpg"), "uploaded");
  const removedBefore = storage.calls.remove;
  const result = await submitBatchPhotos(wang, { ticketId, batchKey: b2, internal: false }, storage.deps);
  assert.equal(result.attached.length, 1);
  assert.equal(result.skipped, 2);
  assert.equal(storage.calls.remove - removedBefore, 2); // Both stale reserved paths cleaned up after commit.
  assert.equal(await attachedCount(ticketId), 7);
  assert.equal((await ticketPhotoRecovery(wang, ticketId, storage.deps))?.draft, null);
  assert.equal((await counts(ticketId)).items, 7); // Closed drafts keep only attached rows.

  // Limit still holds at confirm time: 7 attached, two reserved -> first confirm ok, second limited.
  const b3 = randomUUID(), k1 = randomUUID(), k2 = randomUUID();
  for (const k of [k1, k2]) {
    const p = await prepareBatchPhoto(wang, { ticketId, batchKey: b3, clientKey: k, fileName: "z.jpg", mime: "image/jpeg", size: JPEG.length, internal: false }, storage.deps);
    assert.equal(p.state, "signed");
    if (p.state === "signed") storage.put(p.uploadUrl, JPEG, "image/jpeg");
  }
  assert.equal((await confirmBatchPhoto(wang, { ticketId, batchKey: b3, clientKey: k1 }, storage.deps)).state, "uploaded");
  await assert.rejects(confirmBatchPhoto(wang, { ticketId, batchKey: b3, clientKey: k2 }, storage.deps), rejectsWith("errors.photoLimit"));
  await assert.rejects(sendFile(wang, storage, ticketId, b3, randomUUID(), "w.jpg"), rejectsWith("errors.photoLimit"));
  // Explicit discard of the caller's own open draft: closes without attaching, removes reserved objects.
  const objectsBefore = storage.objects.size;
  assert.deepEqual(await discardBatchPhotos(wang, { ticketId, batchKey: b3 }, storage.deps), { removed: 2, state: "closed" });
  assert.equal(storage.objects.size, objectsBefore - 2); // k1 + k2 objects removed (w.jpg was refused, never reserved).
  assert.equal(await attachedCount(ticketId), 7);
  assert.equal((await ticketPhotoRecovery(wang, ticketId, storage.deps))?.draft, null);
  assert.deepEqual(await discardBatchPhotos(wang, { ticketId, batchKey: b3 }, storage.deps), { removed: 0, state: "closed" });
});

test("M1 repro B: a draft rejected by the 8-photo trigger stays recoverable by trimming or discarding", async () => {
  await enable();
  const wang = await session(USERS.tenant2, "tenant", null);
  const ticketId = await ticket(wang, wangLease);
  const storage = mockStorage();
  const b1 = randomUUID(), b2 = randomUUID();
  await uploadAll(wang, storage, ticketId, b1, 5);
  const keys = await uploadAll(wang, storage, ticketId, b2, 5);
  await submitBatchPhotos(wang, { ticketId, batchKey: b1, internal: false }, storage.deps);
  await assert.rejects(submitBatchPhotos(wang, { ticketId, batchKey: b2, internal: false }, storage.deps), rejectsWith("errors.photoLimit"));
  assert.equal(await attachedCount(ticketId), 5);
  const view = await ticketPhotoRecovery(wang, ticketId, storage.deps);
  assert.deepEqual(view?.draft?.items.map((i) => i.state), ["uploaded", "uploaded", "uploaded", "uploaded", "uploaded"]);
  // Trim two files (owner-scoped), then submit the rest.
  for (const k of keys.slice(0, 2)) assert.deepEqual(await discardBatchPhotos(wang, { ticketId, batchKey: b2, clientKey: k }, storage.deps), { removed: 1, state: "open" });
  assert.deepEqual(await discardBatchPhotos(wang, { ticketId, batchKey: b2, clientKey: keys[0] }, storage.deps), { removed: 0, state: "open" });
  assert.equal((await submitBatchPhotos(wang, { ticketId, batchKey: b2, internal: false }, storage.deps)).attached.length, 3);
  assert.equal(await attachedCount(ticketId), 8);
  const files = await query<{ n: number }>(`SELECT count(*)::int AS n FROM files WHERE storage_path LIKE '%/tickets/' || $1 || '/%'`, [ticketId]);
  assert.equal(files.rows[0].n, 8);
  assert.equal(storage.objects.size, 8);
  // Attached files cannot be removed: attach and close are one transaction, so the closed draft refuses.
  assert.deepEqual(await discardBatchPhotos(wang, { ticketId, batchKey: b2, clientKey: keys[4] }, storage.deps), { removed: 0, state: "closed" });
  assert.equal(await attachedCount(ticketId), 8);
});

test("probes C/D: a batch is bound to its ticket; a demoted staff member cannot submit", async () => {
  await enable();
  const wang = await session(USERS.tenant2, "tenant", null);
  const maint = await session(USERS.maintenance, "staff", "maintenance");
  const t1 = await ticket(wang, wangLease), t2 = await ticket(wang, wangLease);
  const storage = mockStorage();
  const b = randomUUID(), k = randomUUID();
  assert.equal(await sendFile(wang, storage, t1, b, k, "c.jpg"), "uploaded");
  await assert.rejects(sendFile(wang, storage, t2, b, randomUUID(), "c2.jpg"), rejectsWith("errors.forbidden"));
  await assert.rejects(confirmBatchPhoto(wang, { ticketId: t2, batchKey: b, clientKey: k }, storage.deps), rejectsWith("errors.forbidden"));
  await assert.rejects(submitBatchPhotos(wang, { ticketId: t2, batchKey: b, internal: false }, storage.deps), rejectsWith("errors.forbidden"));
  await assert.rejects(discardBatchPhotos(wang, { ticketId: t2, batchKey: b }, storage.deps), rejectsWith("errors.forbidden"));
  assert.equal(await attachedCount(t2), 0);
  const mb = randomUUID();
  assert.equal(await sendFile(maint, storage, t1, mb, randomUUID(), "i.jpg", { internal: true }), "uploaded");
  await query(`UPDATE org_members SET role = 'accountant' WHERE user_id = $1 AND org_id = $2`, [USERS.maintenance, ORG_ID]);
  try {
    await assert.rejects(submitBatchPhotos(maint, { ticketId: t1, batchKey: mb, internal: true }, storage.deps), rejectsWith("errors.forbidden"));
  } finally {
    await query(`UPDATE org_members SET role = 'maintenance' WHERE user_id = $1 AND org_id = $2`, [USERS.maintenance, ORG_ID]);
  }
  assert.equal(await attachedCount(t1), 0);
});

test("MINOR 1: a held batch lock makes submit fail fast with errors.busy (bounded wait), no partial writes", { timeout: 20_000 }, async () => {
  await enable();
  const wang = await session(USERS.tenant2, "tenant", null);
  const ticketId = await ticket(wang, wangLease);
  const storage = mockStorage();
  const b = randomUUID();
  await uploadAll(wang, storage, ticketId, b, 1);
  const holder = new Client({ connectionString: process.env.DATABASE_URL });
  await holder.connect();
  try {
    await holder.query("BEGIN");
    await holder.query(`SELECT 1 FROM app.b031_upload_batches WHERE client_batch_key = $1 FOR UPDATE`, [b]);
    const started = Date.now();
    await assert.rejects(submitBatchPhotos(wang, { ticketId, batchKey: b, internal: false }, storage.deps), rejectsWith("errors.busy"));
    await assert.rejects(sendFile(wang, storage, ticketId, b, randomUUID(), "b.jpg"), rejectsWith("errors.busy"));
    assert.ok(Date.now() - started < 9_000, "both waits bounded by lock_timeout 3s");
  } finally {
    await holder.query("ROLLBACK").catch(() => {});
    await holder.end();
  }
  assert.equal(await attachedCount(ticketId), 0);
  assert.equal((await submitBatchPhotos(wang, { ticketId, batchKey: b, internal: false }, storage.deps)).attached.length, 1);
});

test("MINOR 4/5: reload after a lost PUT adopts the stored object; adding after a lost submit response starts a new draft", async () => {
  await enable();
  const wang = await session(USERS.tenant2, "tenant", null);
  const ticketId = await ticket(wang, wangLease);
  const storage = mockStorage();
  const b = randomUUID(), k = randomUUID();
  const p = await prepareBatchPhoto(wang, { ticketId, batchKey: b, clientKey: k, fileName: "lost.jpg", mime: "image/jpeg", size: JPEG.length, internal: false }, storage.deps);
  if (p.state === "signed") storage.put(p.uploadUrl, JPEG, "image/jpeg"); // PUT landed; response and confirm lost; reload.
  const view = await ticketPhotoRecovery(wang, ticketId, storage.deps);
  assert.deepEqual(view?.draft?.items.map((i) => [i.clientKey, i.state]), [[k, "uploaded"]]);
  assert.equal(storage.objects.size, 1); // No second object needed.
  // Storage unavailable on restore: stays signed (no throw).
  const b2 = randomUUID(), k2 = randomUUID();
  await prepareBatchPhoto(wang, { ticketId, batchKey: b2, clientKey: k2, fileName: "u.jpg", mime: "image/jpeg", size: JPEG.length, internal: false }, storage.deps);
  const down = await ticketPhotoRecovery(wang, ticketId, { ...storage.deps, info: async () => { throw new FlowError("errors.photoStorage"); } });
  assert.ok(down?.draft);

  // Lost submit response: the submit committed, the browser still holds the old draft key.
  await submitBatchPhotos(wang, { ticketId, batchKey: b, internal: false }, storage.deps);
  assert.equal(await sendFile(wang, storage, ticketId, b, randomUUID(), "next.jpg"), "closed");
  const fresh = randomUUID();
  assert.equal(await sendFile(wang, storage, ticketId, fresh, randomUUID(), "next.jpg"), "uploaded");
  assert.equal((await submitBatchPhotos(wang, { ticketId, batchKey: b, internal: false }, storage.deps)).attached.length, 1); // Replay is safe.
  assert.equal(await attachedCount(ticketId), 1);
});

test("MINOR 2: route body OFF answers 404 after exactly one flag read for every op; ON runs the op owner-scoped", async () => {
  await disable();
  const wang = await session(USERS.tenant2, "tenant", null);
  const ticketId = await ticket(wang, wangLease);
  const body = (op: string) => new Request("http://127.0.0.1/api/tickets/photos/batch", { method: "POST", body: JSON.stringify({ op, ticketId, batchKey: randomUUID(), clientKey: randomUUID() }) });
  const before = await counts(ticketId);
  for (const op of ["prepare", "confirm", "submit", "discard", "remove", "bogus"]) {
    const { statements, result } = await traced(() => handleUploadBatch(body(op), wang));
    assert.deepEqual(statements, [FLAG_READ], op);
    assert.equal((result as Response).status, 404, op);
    assert.deepEqual(await (result as Response).json(), { ok: false, error: "errors.notFound" });
  }
  assert.deepEqual(await counts(ticketId), before);
  await enable();
  const unknown = await handleUploadBatch(body("discard"), wang);
  assert.equal(unknown.status, 403); // Unknown draft key for this owner: refused, never a new draft.
  assert.equal((await handleUploadBatch(body("bogus"), wang)).status, 404);
  await disable();
});
