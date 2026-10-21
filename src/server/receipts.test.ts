import assert from "node:assert/strict";
import test from "node:test";
import { FlowError } from "./errors";
import { confirmReceipt, issueReceiptGrant, receiptGrantMatches } from "./receipts";
import { receiptPath } from "./receipt-rules";
import type { Session } from "./types";

const ORG = "10000000-0000-4000-8000-000000000001";
const FILE = "40000000-0000-4000-8000-0000000000aa";
const JPEG = Uint8Array.of(0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01);

function staff(): Session {
  return {
    userId: "20000000-0000-4000-8000-000000000001",
    sessionId: "receipts",
    email: "admin@songxin.demo",
    name: "Admin",
    kind: "staff",
    role: "admin",
    orgId: ORG,
    liveOrgId: ORG,
    environment: "live",
    locale: "zh-TW",
    calendar: "gregorian",
    leaseId: null,
  };
}

test("confirm accepts a signed JPEG and drops a file that is not a receipt", async () => {
  if (!process.env.SUPABASE_SERVICE_ROLE_KEY && !process.env.RECEIPT_GRANT_KEY) {
    process.env.RECEIPT_GRANT_KEY = "unit-grant";
  }
  const session = staff();
  const path = receiptPath(ORG, FILE, "image/jpeg");
  const token = issueReceiptGrant(session.userId, path);
  assert.ok(token);
  assert.equal(receiptGrantMatches(session.userId, path, token), true);
  assert.equal(receiptGrantMatches(session.userId, path, "nope"), false);
  let removed = 0;
  const saved = await confirmReceipt(
    session,
    { path, token, fileName: "收據_水電行.jpg", mime: "image/jpeg", size: 820 * 1024 },
    {
      info: async () => ({ ok: true, size: 820 * 1024, mime: "image/jpeg" }),
      header: async () => JPEG,
      remove: async () => {
        removed += 1;
      },
      attach: async () => FILE,
    },
  );
  assert.equal(saved, FILE);
  assert.equal(removed, 0);

  await assert.rejects(
    () =>
      confirmReceipt(
        session,
        { path, token, fileName: "掃描檔_全部.pdf", mime: "application/pdf", size: 11 * 1024 * 1024 },
        {
          info: async () => ({ ok: true, size: 100, mime: "application/pdf" }),
          header: async () => JPEG,
          remove: async () => {
            removed += 1;
          },
          attach: async () => FILE,
        },
      ),
    (error: unknown) => error instanceof FlowError && error.key === "errors.receiptSize",
  );
  assert.equal(removed, 1);

  await assert.rejects(
    () =>
      confirmReceipt(
        session,
        { path, token, fileName: "anim.webp", mime: "image/webp", size: 100 },
        {
          info: async () => ({ ok: true, size: 100, mime: "image/webp" }),
          header: async () => JPEG,
          remove: async () => {
            removed += 1;
          },
          attach: async () => FILE,
        },
      ),
    (error: unknown) => error instanceof FlowError && error.key === "errors.receiptType",
  );
  assert.equal(removed, 2);

  await assert.rejects(
    () =>
      confirmReceipt(
        session,
        { path, token: "forged", fileName: "收據_水電行.jpg", mime: "image/jpeg", size: 100 },
        {
          info: async () => ({ ok: true, size: 100, mime: "image/jpeg" }),
          header: async () => JPEG,
          remove: async () => {
            removed += 1;
          },
          attach: async () => FILE,
        },
      ),
    (error: unknown) => error instanceof FlowError && error.key === "errors.forbidden",
  );
  assert.equal(removed, 2);
});
