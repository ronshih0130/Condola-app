import assert from "node:assert/strict";
import test from "node:test";
import { query } from "./db";
import { markTryout } from "./domain";

test("tryout progress persists and merges safely within its organization", async () => {
  // This test writes only to the explicitly provisioned disposable local database.
  const url = new URL(process.env.DATABASE_URL || "http://invalid");
  assert.ok(process.env.CONDOLA_RLS_DISPOSABLE === "YES" && ["postgres:", "postgresql:"].includes(url.protocol) && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) && url.pathname.length > 1 && !url.search && !url.hash, "requires an explicitly disposable loopback PostgreSQL URL without query parameters");
  const ids: string[] = [];
  const initial: Record<string, unknown>[] = [];
  try {
    for (const settings of [
      { plan: { tier: "free" }, signup: { source: "v2" } },
      { tryout: { lease: true, other: "preserved" }, country: "TW" },
      { tryout: null, unrelated: 7 },
      { tryout: ["invalid"], unrelated: 8 },
      { unrelated: "untouched" },
    ]) {
      const inserted = await query<{ id: string; settings: Record<string, unknown> }>(
        `INSERT INTO organizations (name, country_code, default_currency, settings)
         VALUES ('Synthetic tryout test', 'TW', 'TWD', $1::jsonb) RETURNING id::text, settings`,
        [JSON.stringify(settings)],
      );
      ids.push(inserted.rows[0].id);
      initial.push(inserted.rows[0].settings);
    }

    // Negative control: the original nested update does not create an intermediate object.
    await query(`UPDATE organizations SET settings = jsonb_set(coalesce(settings, '{}'::jsonb), ARRAY['tryout', $2]::text[], 'true'::jsonb, true) WHERE id = $1`, [ids[0], "property"]);
    const baseline = await query<{ settings: unknown }>(`SELECT settings FROM organizations WHERE id = $1`, [ids[0]]);
    assert.deepEqual(baseline.rows[0].settings, initial[0]);

    await Promise.all([markTryout(ids[0], "property"), markTryout(ids[0], "lease"), markTryout(ids[0], "statement")]);
    await markTryout(ids[0], "property");
    await markTryout(ids[1], "property");
    await markTryout(ids[2], "lease");
    await markTryout(ids[3], "statement");
    const rows = await query<{ id: string; settings: unknown }>(
      `SELECT id::text, settings FROM organizations WHERE id = ANY($1::uuid[])`, [ids],
    );
    const saved = new Map(rows.rows.map((row) => [row.id, row.settings]));
    assert.deepEqual(saved.get(ids[0]), { ...initial[0], tryout: { property: true, lease: true, statement: true } });
    assert.deepEqual(saved.get(ids[1]), { ...initial[1], tryout: { lease: true, other: "preserved", property: true } });
    assert.deepEqual(saved.get(ids[2]), { ...initial[2], tryout: { lease: true } });
    assert.deepEqual(saved.get(ids[3]), { ...initial[3], tryout: { statement: true } });
    assert.deepEqual(saved.get(ids[4]), initial[4]);
  } finally {
    if (ids.length) await query(`DELETE FROM organizations WHERE id = ANY($1::uuid[])`, [ids]);
  }
});
