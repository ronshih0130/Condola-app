import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import test from "node:test";
import { FlowError } from "./errors";
import {
  PHOTO_MAX_BYTES,
  acceptPhotoObject,
  assertPhotoMeta,
  cleanVendorName,
  completionDate,
  datesInOrder,
  expenseLinkPlan,
  isTicketPhotoPath,
  minorToInput,
  parseOptionalDate,
  parseOptionalMoney,
  ticketPhotoPath,
} from "./repair-rules";

const root = new URL("../../", import.meta.url);

test("photo rules cap size and type and never describe a re-encode", () => {
  const ok = assertPhotoMeta({ fileName: "浴室.jpg", mime: "image/jpeg", size: 1200 });
  assert.equal(ok.mime, "image/jpeg");
  assert.equal(ok.size, 1200);
  assert.throws(() => assertPhotoMeta({ fileName: "a.heic", mime: "image/heic", size: 100 }), (error: unknown) => {
    return error instanceof FlowError && error.key === "errors.photoType";
  });
  assert.throws(() => assertPhotoMeta({ fileName: "a.jpg", mime: "image/jpeg", size: PHOTO_MAX_BYTES + 1 }), (error: unknown) => {
    return error instanceof FlowError && error.key === "errors.photoSize";
  });
  const accepted = acceptPhotoObject({ size: 40, mime: "image/jpg" }, "image/jpeg");
  assert.deepEqual(accepted, { size: 40, mime: "image/jpeg" });

  const path = ticketPhotoPath(
    "10000000-0000-4000-8000-000000000001",
    "30000000-0000-4000-8000-000000000002",
    "40000000-0000-4000-8000-000000000003",
    "image/png",
  );
  assert.equal(
    isTicketPhotoPath(path, "10000000-0000-4000-8000-000000000001", "30000000-0000-4000-8000-000000000002"),
    true,
  );
  assert.equal(isTicketPhotoPath(path, "10000000-0000-4000-8000-000000000009", "30000000-0000-4000-8000-000000000002"), false);

  const server = readFileSync(new URL("./ticket-photos.ts", import.meta.url), "utf8");
  const client = readFileSync(new URL("../components/ticket-photos.tsx", import.meta.url), "utf8");
  const view = readFileSync(new URL("../components/repair-thread.tsx", import.meta.url), "utf8");
  for (const source of [server, client, view]) {
    assert.equal(source.includes("sharp"), false);
    assert.equal(source.includes("createImageBitmap"), false);
    assert.equal(source.includes("toDataURL"), false);
    assert.equal(source.includes("OffscreenCanvas"), false);
  }
  assert.match(client, /body: file/);
  assert.match(view, /no-img-element/);
  assert.doesNotMatch(view, /from "next\/image"/);
});

test("dates, money, vendor, and the expense link stay optional", () => {
  assert.equal(parseOptionalDate(""), null);
  assert.equal(parseOptionalDate("2026-11-12"), "2026-11-12");
  assert.throws(() => parseOptionalDate("2026-02-31"), (error: unknown) => error instanceof FlowError && error.key === "errors.date");
  assert.throws(() => datesInOrder("2026-11-12", "2026-11-01"), (error: unknown) => error instanceof FlowError && error.key === "errors.date");
  assert.equal(parseOptionalMoney(""), null);
  assert.equal(parseOptionalMoney("1800"), 180000);
  assert.equal(minorToInput("180000"), "1800");
  assert.equal(cleanVendorName("  老張水電  "), "老張水電");
  assert.equal(cleanVendorName("   "), null);
  assert.equal(completionDate("resolved", null, "2026-11-12"), "2026-11-12");
  assert.equal(completionDate("open", null, "2026-11-12"), null);
  assert.equal(completionDate("closed", "2026-11-02", "2026-11-12"), "2026-11-02");

  assert.equal(expenseLinkPlan({ post: false, finalMinor: 100, expenseId: null, canPost: true }), "skip");
  assert.equal(expenseLinkPlan({ post: true, finalMinor: null, expenseId: "exp", canPost: true }), "keep");
  assert.equal(expenseLinkPlan({ post: true, finalMinor: 100, expenseId: null, canPost: true }), "create");
  assert.throws(
    () => expenseLinkPlan({ post: true, finalMinor: 100, expenseId: null, canPost: false }),
    (error: unknown) => error instanceof FlowError && error.key === "errors.forbidden",
  );
  assert.throws(
    () => expenseLinkPlan({ post: true, finalMinor: 0, expenseId: null, canPost: true }),
    (error: unknown) => error instanceof FlowError && error.key === "errors.amount",
  );
});

test("the repair migration follows 20261023090000 and posts only a draft link", () => {
  const names = readdirSync(new URL("supabase/migrations/", root)).filter((name) => name.endsWith(".sql")).sort();
  const repair = names.find((name) => name.includes("repair_records"));
  assert.ok(repair);
  assert.ok(repair > "20261023090000");
  assert.ok(names.includes("20261023090000_lease_deposit_override_check.sql"));
  const sql = readFileSync(new URL(`supabase/migrations/${repair}`, root), "utf8");
  assert.match(sql, /tenant_owns_ticket/);
  assert.match(sql, /ticket-photos-private/);
  assert.match(sql, /file_size_limit/);
  assert.match(sql, /5242880/);
  assert.match(sql, /expense_id uuid/);
  assert.match(sql, /"public" = false/);
  assert.doesNotMatch(sql, /INSERT INTO ledger/);

  const repairs = readFileSync(new URL("./repairs.ts", import.meta.url), "utf8");
  assert.match(repairs, /'draft'/);
  assert.match(repairs, /ticket_id/);
  assert.doesNotMatch(repairs, /ledger_transactions/);
  const domain = readFileSync(new URL("./domain.ts", import.meta.url), "utf8");
  assert.match(domain, /status IN \('approved','posted'\)/);
});
