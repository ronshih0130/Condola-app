import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { paperHistoryTime, signedPdfUploadedAt } from "./paper-lease-history-time";

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

test("signed PDF upload time is Asia/Taipei on the tenant and staff panels", () => {
  const shown = signedPdfUploadedAt("2027-01-01T00:30:00.654321Z", "zh-TW")!;
  assert.equal(shown.iso, "2027-01-01T00:30:00.654Z");
  assert.match(shown.label, /08:30/);
  assert.match(shown.label, /Asia\/Taipei/);
  assert.doesNotMatch(shown.label, /00:30/);
  const fromDate = signedPdfUploadedAt(new Date("2027-01-01T16:05:00Z"), "en")!;
  assert.match(fromDate.label, /00:05/);
  assert.match(fromDate.label, /Asia\/Taipei/);
  for (const path of [
    "../app/t/lease/page.tsx",
    "../app/t/history/[leaseId]/page.tsx",
    "./paper-lease-versions-panel.tsx",
  ]) {
    const source = readFileSync(new URL(path, import.meta.url), "utf8");
    assert.match(source, /signedPdfUploadedAt\(/, path);
    assert.doesNotMatch(source, /toLocaleString\(/, path);
  }
});
