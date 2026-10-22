import assert from "node:assert/strict";
import test from "node:test";
import type { Client } from "pg";
import { BYTEA_CHUNK, byteaChunks, copySlotCiphertext, readCiphertext, writeCiphertext } from "./id-bytes";

test("bytea slices stay at 24KiB so a Bind and its hex DataRow fit under 64KiB", () => {
  assert.equal(BYTEA_CHUNK, 24 * 1024);
  const blob = Buffer.alloc(800 * 1024, 7);
  const chunks = byteaChunks(blob);
  assert.ok(chunks.length > 1);
  assert.equal(chunks.every((chunk) => chunk.length <= BYTEA_CHUNK), true);
  assert.equal(Buffer.concat(chunks).equals(blob), true);
  assert.equal(byteaChunks(Buffer.alloc(BYTEA_CHUNK, 1)).length, 1);
  assert.equal(byteaChunks(Buffer.alloc(BYTEA_CHUNK + 1, 1)).length, 2);
});

test("writeCiphertext never binds a bytea larger than 24KiB", async () => {
  const calls: unknown[][] = [];
  const client = {
    query: async (_sql: string, params: unknown[] = []) => {
      calls.push(params);
      return { rows: [] };
    },
  } as unknown as Client;
  const blob = Buffer.alloc(800 * 1024, 9);
  await writeCiphertext(client, {
    bucket: "id-documents-private",
    path: "org/doc/front",
    mime: "image/jpeg",
    sha256: "ab",
    ciphertext: blob,
  });
  const byteaParams = calls.flat().filter((param): param is Buffer => Buffer.isBuffer(param));
  assert.ok(byteaParams.length > 1);
  assert.equal(byteaParams.every((param) => param.length <= BYTEA_CHUNK), true);
  assert.equal(Buffer.concat(byteaParams).equals(blob), true);
  assert.equal(calls[0]?.[3], blob.length);
});

test("copySlotCiphertext never binds a bytea", async () => {
  const calls: { sql: string; params: unknown[] }[] = [];
  const total = 70 * 1024;
  const client = {
    query: async (sql: string, params: unknown[] = []) => {
      calls.push({ sql, params });
      if (sql.includes("mime_type")) return { rows: [{ n: total, mime: "image/jpeg", sha256: "ab" }] };
      if (sql.includes("octet_length")) return { rows: [{ n: total }] };
      return { rows: [] };
    },
  } as unknown as Client;
  await copySlotCiphertext(client, {
    bucket: "id-documents-private",
    userId: "20000000-0000-4000-8000-000000000006",
    leaseId: "30000000-0000-4000-8000-000000000001",
    orgId: "10000000-0000-4000-8000-000000000001",
    documentId: "40000000-0000-4000-8000-000000000001",
    slot: "front",
  });
  assert.ok(calls.length >= 4);
  assert.match(calls.map((call) => call.sql).join("\n"), /substring\(ciphertext from/);
  for (const call of calls) {
    for (const param of call.params) {
      assert.equal(Buffer.isBuffer(param), false);
      assert.equal(param instanceof Uint8Array, false);
      assert.ok(typeof param === "string" || typeof param === "number");
    }
  }
  const lengths = calls.flatMap((call) => call.params.filter((param): param is number => param === BYTEA_CHUNK));
  assert.ok(lengths.length >= 2);
});

test("readCiphertext reassembles 24KiB slices", async () => {
  const blob = Buffer.alloc(70 * 1024, 4);
  const client = {
    query: async (sql: string, params: unknown[] = []) => {
      if (sql.includes("octet_length")) return { rows: [{ n: blob.length }] };
      const start = Number(params[2]);
      const len = Number(params[3]);
      assert.ok(len <= BYTEA_CHUNK);
      return { rows: [{ chunk: blob.subarray(start - 1, start - 1 + len) }] };
    },
  } as unknown as Client;
  const out = await readCiphertext(client, "b", "p");
  assert.ok(out);
  assert.equal(out.equals(blob), true);
});
