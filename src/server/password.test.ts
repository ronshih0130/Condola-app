import assert from "node:assert/strict";
import test from "node:test";
import { passwordAcceptable, passwordIssues } from "./password";

test("password rules reject short, non-alphanumeric, and common passwords", () => {
  assert.deepEqual(passwordIssues("short1"), ["length"]);
  assert.ok(passwordIssues("longpassword").includes("alnum"));
  assert.ok(passwordIssues("password1").includes("common"));
  assert.equal(passwordAcceptable("Demo1234"), true);
});
