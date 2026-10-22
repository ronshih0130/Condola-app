import assert from "node:assert/strict";
import test from "node:test";
import { canonicalRoomType, electricityCapBlocked } from "./property-draft";

test("the reported meter preview is under the cap, and room labels map to stored types", () => {
  const preview = electricityCapBlocked("300", "5", "3", "");
  assert.equal(preview.average, 60);
  assert.equal(preview.over, false);
  assert.equal(preview.blocked, false);
  assert.equal(electricityCapBlocked("300", "5", "61", "").blocked, true);
  assert.equal(electricityCapBlocked("300", "5", "61", "屋主同意").blocked, false);
  assert.equal(canonicalRoomType("雅房"), "shared_bath");
  assert.equal(canonicalRoomType("獨立套房"), "studio");
  assert.equal(canonicalRoomType("suite"), "suite");
  assert.equal(canonicalRoomType(""), "suite");
  assert.equal(canonicalRoomType("loft"), null);
});
