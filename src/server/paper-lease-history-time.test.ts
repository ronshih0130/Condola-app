import { strict as assert } from "node:assert";
import { test } from "node:test";
import { paperHistoryTime } from "./paper-lease-history-time";

test("history time uses selected zone, Gregorian calendar, and an ISO instant", () => {
  const taipei = paperHistoryTime("2027-01-01T00:30:00Z", "Asia/Taipei", "zh-TW")!;
  assert.equal(taipei.iso, "2027-01-01T00:30:00.000Z");
  assert.match(taipei.label, /2027/);
  assert.match(taipei.label, /08:30.*Asia\/Taipei/);
  assert.match(paperHistoryTime("2027-01-01T00:30:00Z", "Asia/Taipei", "zh-TW", "roc")!.label, /116/);
  const winter = paperHistoryTime("2027-01-01T00:30:00Z", "America/Los_Angeles", "en")!;
  const summer = paperHistoryTime("2027-07-01T00:30:00Z", "America/Los_Angeles", "en")!;
  assert.match(winter.label, /16:30.*America\/Los_Angeles/);
  assert.match(summer.label, /17:30.*America\/Los_Angeles/);
  assert.match(paperHistoryTime("2027-01-01T00:30:00Z", "bad-zone", "en")!.label, /00:30.*UTC/);
  assert.equal(paperHistoryTime("invalid", "UTC", "en"), null);
  assert.equal(paperHistoryTime("2027-01-01T00:30:00", "UTC", "en"), null);
});
