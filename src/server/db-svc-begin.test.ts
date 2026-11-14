import assert from "node:assert/strict";
import test from "node:test";
import { svcBeginStatement } from "./db";

// B-056 r3-final #5: svcOn honours options.isolation on writable transactions too.
test("svcOn BEGIN: default, read-only default RR, and explicit isolation on writable txns", () => {
  assert.equal(svcBeginStatement(), "BEGIN");
  assert.equal(svcBeginStatement({}), "BEGIN");
  assert.equal(svcBeginStatement({ readOnly: true }), "BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
  assert.equal(svcBeginStatement({ isolation: "repeatable read" }), "BEGIN ISOLATION LEVEL REPEATABLE READ");
  assert.equal(svcBeginStatement({ isolation: "read committed" }), "BEGIN ISOLATION LEVEL READ COMMITTED");
  assert.equal(svcBeginStatement({ isolation: "read committed", readOnly: true }), "BEGIN ISOLATION LEVEL READ COMMITTED READ ONLY");
  assert.equal(svcBeginStatement({ isolation: "repeatable read", readOnly: true }), "BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
});
