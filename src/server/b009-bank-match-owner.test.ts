import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

test("B009 direct-write guard trusts only the table-owner login without a role switch", () => {
  const sql = readFileSync(
    new URL("../../supabase/migrations/20261104120400_b009_bank_match_owner.sql", import.meta.url),
    "utf8",
  );
  assert.match(sql, /v_login text := session_user::text/);
  assert.match(sql, /v_active text := coalesce\(nullif\(current_setting\('role', true\), 'none'\), v_login\)/);
  assert.match(sql, /n\.nspname = 'public' AND c\.relname = 'bank_transactions'/);
  assert.match(sql, /v_login = v_owner AND v_active = v_owner/);
  assert.doesNotMatch(sql, /current_user::text/);
});
