import assert from "node:assert/strict";
import test from "node:test";
import { assertIdPurgeTarget, ID_PURGE_BUCKET, idPurgeMayDelete } from "./id-purge-guard";
import { runIdPurge } from "../../id-purge-cron.mjs";

test("ID purge accepts only private ID relative keys", () => {
  for (const path of ["org/document/front", "org/document/front.wm", "photo.jpg"]) {
    assert.doesNotThrow(() => assertIdPurgeTarget({ bucket: ID_PURGE_BUCKET, path }));
  }
  for (const bucket of ["lease-documents-private", "ticket-photos-private", ""]) {
    assert.throws(() => assertIdPurgeTarget({ bucket, path: "org/photo.jpg" }));
  }
  for (const path of ["", " ", "../x", "/abs", "a\\b", "a/../b"]) {
    assert.throws(() => assertIdPurgeTarget({ bucket: ID_PURGE_BUCKET, path }));
  }
});

test("ID purge permits only the ID photo kind", () => {
  assert.equal(idPurgeMayDelete("id_photo"), true);
  for (const kind of [
    "",
    "lease_document",
    "audit_trail",
    "ticket_photo",
    "move_in_photo",
    "contract",
    "signature_image",
    "message_attachment",
    "files",
    "identity_document_access_log",
    "esign_envelopes",
    "esign_documents",
  ]) {
    assert.equal(idPurgeMayDelete(kind), false);
  }
});

test("runner clamps bounds and rolls back a whole invalid returned batch", async () => {
  const calls: { sql: string; params?: unknown[] }[] = [];
  const client = {
    async query(sql: string, params?: unknown[]) {
      calls.push({ sql, params });
      if (sql.includes("FROM public.purge_due_identity_documents")) {
        return {
          rows: [
            { document_id: "one", storage_bucket: ID_PURGE_BUCKET, storage_path: "ok/front" },
            { document_id: "two", storage_bucket: "lease-documents-private", storage_path: "lease.pdf" },
          ],
        };
      }
      return { rows: [] };
    },
  };
  await assert.rejects(
    runIdPurge(client, {
      limit: 99999,
      maxBatches: 99999,
      assertTarget: assertIdPurgeTarget,
    }),
    /Unsafe ID purge target/,
  );
  const purge = calls.find((call) => call.sql.includes("FROM public.purge_due_identity_documents"));
  assert.deepEqual(purge?.params, [1000]);
  assert.equal(calls.some((call) => call.sql === "ROLLBACK"), true);
  assert.equal(calls.filter((call) => call.sql.includes("INSERT INTO public.audit_log")).length, 1);
});

test("dry-run calls preview once and performs no deletion", async () => {
  const calls: { sql: string; params?: unknown[] }[] = [];
  const client = {
    async query(sql: string, params?: unknown[]) {
      calls.push({ sql, params });
      return {
        rows: sql.includes("FROM public.preview_due_identity_documents")
          ? [{ document_id: "one", storage_bucket: ID_PURGE_BUCKET, storage_path: "ok/front" }]
          : [],
      };
    },
  };
  const result = await runIdPurge(client, {
    dryRun: true,
    limit: -4,
    maxBatches: 0,
    assertTarget: assertIdPurgeTarget,
  });
  assert.equal(result.dryRun, true);
  assert.equal(result.wouldDelete, 1);
  assert.deepEqual(result.byBucket, { [ID_PURGE_BUCKET]: 1 });
  assert.equal(calls.some((call) => /\bDELETE\b/.test(call.sql)), false);
  assert.equal(calls.some((call) => call.sql.includes("FROM public.purge_due_identity_documents")), false);
  assert.deepEqual(
    calls.find((call) => call.sql.includes("FROM public.preview_due_identity_documents"))?.params,
    [1],
  );
  assert.equal(calls.filter((call) => call.sql.includes("INSERT INTO public.audit_log")).length, 1);
});
