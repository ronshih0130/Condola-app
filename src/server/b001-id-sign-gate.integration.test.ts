import assert from "node:assert/strict";
import test from "node:test";
import { Client } from "pg";
import { ORG_ID } from "./ids";
import { identityRequiredForSigning } from "./id-sign-gate";
import { cloneTestDatabase } from "./test-database-clone";
import { disposableDbUrl } from "./test-disposable-db";

disposableDbUrl(process.env.DATABASE_URL, process.env.CONDOLA_RLS_DISPOSABLE);
let clone: Awaited<ReturnType<typeof cloneTestDatabase>>, db: Client;
test.before(async () => { clone = await cloneTestDatabase(); db = new Client({ connectionString: clone.url }); await db.connect(); });
test.after(async () => { await db?.end(); await clone?.cleanup(); });

async function flag(on: boolean) {
  await db.query(`UPDATE platform_settings SET value=jsonb_build_object('enabled',$1::boolean,'allowed_org_ids',jsonb_build_array($2::text)) WHERE key='id_sign_gate_v2'`, [on, ORG_ID]);
  await db.query(`UPDATE organizations SET feature_flags=feature_flags || jsonb_build_object('id_sign_gate_v2',$1::boolean) WHERE id=$2`, [on, ORG_ID]);
}
async function settings(value: Record<string, unknown>) {
  await db.query(`UPDATE organizations SET settings=(settings - 'collect_id' - 'require_id_before_sign') || $1::jsonb WHERE id=$2`, [JSON.stringify(value), ORG_ID]);
}

test("seeded flag is OFF and keeps the legacy hard gate", async () => {
  const seeded = (await db.query<{ value: unknown }>(`SELECT value FROM platform_settings WHERE key='id_sign_gate_v2'`)).rows[0];
  assert.deepEqual(seeded.value, { enabled: false, allowed_org_ids: [] });
  await settings({ collect_id: true, require_id_before_sign: false });
  assert.equal(await identityRequiredForSigning(db, ORG_ID), true);
});

test("flag ON: block only when collect_id ∧ require_id_before_sign", async () => {
  await flag(true);
  await settings({});
  assert.equal(await identityRequiredForSigning(db, ORG_ID), false);
  await settings({ collect_id: true, require_id_before_sign: true });
  assert.equal(await identityRequiredForSigning(db, ORG_ID), true);
  await settings({ collect_id: false, require_id_before_sign: true });
  assert.equal(await identityRequiredForSigning(db, ORG_ID), false);
  await settings({ collect_id: false });
  assert.equal(await identityRequiredForSigning(db, ORG_ID), false);
  await settings({ collect_id: true, require_id_before_sign: "true" });
  assert.equal(await identityRequiredForSigning(db, ORG_ID), true, "malformed switch fails closed");
  await flag(false);
  assert.equal(await identityRequiredForSigning(db, ORG_ID), true);
});
