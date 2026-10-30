import assert from "node:assert/strict";
import test from "node:test";
import { disposableDbUrl, withDatabase } from "./test-disposable-db";

test("disposable database guard requires consent, explicit local port, named database and no overrides", () => {
  const valid = "postgresql://test:test@127.0.0.1:55435/testdb";
  assert.throws(() => disposableDbUrl(valid, undefined));
  for (const url of [undefined, "invalid", "https://127.0.0.1:55435/db", "postgres://remote:55435/db", "postgres://127.0.0.1/db", "postgres://127.0.0.1:0/db", "postgres://127.0.0.1:55435/", "postgres://127.0.0.1:55435/db?host=remote", "postgres://127.0.0.1:55435/db#fragment"]) {
    assert.throws(() => disposableDbUrl(url, "YES"));
  }
  const explicit5432 = "postgres://127.0.0.1:5432/db";
  assert.equal(disposableDbUrl(explicit5432, "YES").port, "5432");
  assert.throws(() => disposableDbUrl(explicit5432, undefined));
  const target = disposableDbUrl(valid, "YES");
  const scratch = new URL(withDatabase(target, "condola_test_a123"));
  assert.equal(scratch.host, target.host);
  assert.equal(scratch.pathname, "/condola_test_a123");
  assert.throws(() => withDatabase(target, "x;drop database test"));
});
