import assert from "node:assert/strict";
import test from "node:test";
import { parseRequestId } from "./_request-id";

test("requestId is preserved verbatim across retries", () => {
  for (const value of [
    "6dbf5a6c-2458-4daa-9f32-291a6b61d332",
    "6DBF5A6C-2458-4DAA-9F32-291A6B61D332",
  ]) assert.equal(parseRequestId(value), value);
});

test("requestId rejects missing, padded, and malformed values", () => {
  for (const value of [
    undefined, null, "", 42, {}, [],
    "not-a-uuid",
    "6dbf5a6c24584daa9f32291a6b61d332",
    "6dbf5a6c-2458-4daa-9f32-291a6b61d33g",
    " 6dbf5a6c-2458-4daa-9f32-291a6b61d332",
    "6dbf5a6c-2458-4daa-9f32-291a6b61d332\n",
  ]) assert.equal(parseRequestId(value), null);
});
