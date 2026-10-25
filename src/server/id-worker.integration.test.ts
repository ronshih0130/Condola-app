import "./load-local-env";
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { Client } from "pg";
import { unstable_dev, type Unstable_DevWorker } from "wrangler";
import { SAMPLE_JPEG_BASE64 } from "../lib/idv";
import { embedIdWatermarkMark } from "../lib/jpeg-size";
import { USERS } from "./ids";
import { parseIdKey } from "./id-keys";

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "../..");
const DATABASE_URL = process.env.DATABASE_URL ?? "postgres://condola:condola@127.0.0.1:5432/condola";
const marked = embedIdWatermarkMark(Buffer.from(SAMPLE_JPEG_BASE64, "base64"));
if (!marked) throw new Error("sample jpeg has no watermark mark");
const PHOTO = Buffer.from(marked);
const SLOTS = ["front", "selfie"] as const;
const PER_PHOTO_MS = 2000;

function keyMaterial(name: string) {
  const current = process.env[name]?.trim() ?? "";
  if (current && parseIdKey(current)) return current;
  const generated = randomBytes(32).toString("base64");
  process.env[name] = generated;
  return generated;
}

function bundleHas(needle: string) {
  const root = path.join(ROOT, ".open-next/server-functions/default");
  const walk = (dir: string): boolean => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (walk(file)) return true;
        continue;
      }
      if (!/\.(?:mjs|js)$/.test(entry.name)) continue;
      if (readFileSync(file).includes(needle)) return true;
    }
    return false;
  };
  return walk(root);
}

async function withDb<T>(fn: (client: Client) => Promise<T>) {
  const client = new Client({ connectionString: DATABASE_URL });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

async function clearLease(leaseId: string) {
  await withDb(async (client) => {
    const docs = await client.query<{ id: string }>(`SELECT id::text FROM identity_documents WHERE lease_id = $1`, [leaseId]);
    await client.query("BEGIN");
    try {
      if (docs.rows.length) {
        await client.query(`SELECT set_config('app.allow_id_access_log_delete', $1, true)`, [
          docs.rows.map((row) => row.id).join(","),
        ]);
        await client.query(`DELETE FROM identity_documents WHERE lease_id = $1`, [leaseId]);
      }
      await client.query(`DELETE FROM id_upload_slots WHERE lease_id = $1`, [leaseId]);
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    }
  });
}

test("the built worker uploads and finalizes an ID photo with bundled fonts", { timeout: 180_000 }, async () => {
  const serverDir = path.join(ROOT, ".open-next/server-functions/default");
  assert.ok(existsSync(path.join(ROOT, ".open-next/worker.js")), "run npm run cf:build before this test");
  assert.ok(existsSync(serverDir), "OpenNext server bundle is missing");
  const cjk = readFileSync(path.join(ROOT, "public/fonts/DroidSansFallback-subset.ttf")).subarray(0, 48).toString("base64");
  const latin = readFileSync(path.join(ROOT, "src/server/fonts/DejaVuSans.ttf")).subarray(0, 48).toString("base64");
  assert.equal(bundleHas(cjk), false, "font bytes are inlined in the server bundle; keep them as Wrangler Data modules");
  assert.equal(bundleHas(latin), false, "font bytes are inlined in the server bundle; keep them as Wrangler Data modules");

  const lease = await withDb(async (client) => {
    const found = await client.query<{ lease_id: string }>(
      `SELECT l.id::text AS lease_id
         FROM lease_parties lp
         JOIN contacts c ON c.id = lp.contact_id
         JOIN leases l ON l.id = lp.lease_id
        WHERE c.user_id = $1 AND lp.role = 'primary'
        LIMIT 1`,
      [USERS.tenant2],
    );
    return found.rows[0]?.lease_id ?? "";
  });
  assert.ok(lease, "seed a primary lease for the demo tenant before this test");
  await clearLease(lease);

  const token = randomBytes(32).toString("hex");
  const tokenHash = createHash("sha256").update(token).digest("hex");
  await withDb((client) =>
    client.query(
      `INSERT INTO auth_sessions (user_id, token_hash, expires_at) VALUES ($1, $2, now() + interval '1 hour')`,
      [USERS.tenant2, tokenHash],
    ),
  );

  const configDir = path.join(tmpdir(), `condola-worker-${process.pid}`);
  const configPath = path.join(configDir, "wrangler.json");
  let worker: Unstable_DevWorker | null = null;
  try {
    mkdirSync(configDir, { recursive: true });
    writeFileSync(
      configPath,
      JSON.stringify(
        {
          name: "condola-id-worker-test",
          main: path.join(ROOT, "custom-worker.mjs"),
          compatibility_date: "2026-10-01",
          compatibility_flags: ["nodejs_compat"],
          assets: { directory: path.join(ROOT, ".open-next/assets"), binding: "ASSETS" },
          rules: [{ type: "Data", globs: ["**/*.ttf"], fallthrough: true }],
        },
        null,
        2,
      ),
    );
    worker = await unstable_dev(path.join(ROOT, "custom-worker.mjs"), {
      config: configPath,
      local: true,
      bundle: true,
      inspect: false,
      logLevel: "error",
      vars: {
        DATABASE_URL,
        ID_DOC_ENCRYPTION_KEY: keyMaterial("ID_DOC_ENCRYPTION_KEY"),
        ID_DOC_HMAC_KEY: keyMaterial("ID_DOC_HMAC_KEY"),
        ID_DOC_SIGNING_SECRET: keyMaterial("ID_DOC_SIGNING_SECRET"),
        DEMO_MODE: "false",
      },
      experimental: { disableExperimentalWarning: true, forceLocal: true, disableDevRegistry: true },
    });

    const cookie = `condola_session=${token}; condola_portal_role=tenant`;
    const warmup = await worker.fetch("http://127.0.0.1/login");
    await warmup.arrayBuffer();
    assert.ok(warmup.status < 500, `worker warmup failed: ${warmup.status}`);

    for (const slot of SLOTS) {
      const started = performance.now();
      const uploaded = await worker.fetch("http://127.0.0.1/api/id-documents/photo", {
        method: "POST",
        headers: {
          cookie,
          "content-type": "image/jpeg",
          "x-id-slot": slot,
          "x-id-lease": lease,
        },
        body: PHOTO,
      });
      const uploadMs = performance.now() - started;
      const uploadBody = await uploaded.text();
      assert.equal(uploaded.status, 200, uploadBody);
      assert.ok(uploadMs < PER_PHOTO_MS, `${slot} upload took ${Math.round(uploadMs)}ms`);
    }

    const started = performance.now();
    const finalized = await worker.fetch("http://127.0.0.1/api/id-documents/finalize", {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ leaseId: lease, docType: "passport", number: "E1234567", consent: true }),
    });
    const finalizeMs = performance.now() - started;
    const finalizeBody = await finalized.text();
    assert.equal(finalized.status, 200, finalizeBody);
    assert.equal(JSON.parse(finalizeBody).ok, true);
    assert.ok(
      finalizeMs < PER_PHOTO_MS * SLOTS.length,
      `finalize took ${Math.round(finalizeMs)}ms for ${SLOTS.length} photos`,
    );

    const stored = await withDb(async (client) => {
      const row = await client.query<{ n: number; originals: number }>(
        `SELECT (SELECT count(*)::int
                   FROM id_document_wm_objects w
                  WHERE w.path LIKE d.org_id::text || '/' || d.id::text || '/%'
                    AND octet_length(w.ciphertext) > 0) AS n,
                (SELECT count(*)::int
                   FROM id_document_objects o
                  WHERE o.path LIKE d.org_id::text || '/' || d.id::text || '/%'
                    AND octet_length(o.ciphertext) > 0) AS originals
           FROM identity_documents d
          WHERE d.lease_id = $1 AND d.deleted_at IS NULL`,
        [lease],
      );
      return row.rows[0];
    });
    assert.equal(stored?.originals, SLOTS.length);
    assert.equal(stored?.n, SLOTS.length);
  } finally {
    await worker?.stop();
    rmSync(configDir, { recursive: true, force: true });
    await withDb((client) => client.query(`DELETE FROM auth_sessions WHERE token_hash = $1`, [tokenHash])).catch(() => undefined);
    await clearLease(lease).catch(() => undefined);
  }
});
