import assert from "node:assert/strict";
import test from "node:test";
import {
  tenantSignedPdfDownload,
  type SignedPdfDownloadAudit,
} from "./tenant-signed-pdf-download";

const event: SignedPdfDownloadAudit = {
  orgId: "org",
  userId: "tenant",
  leaseId: "lease",
  pdfId: "pdf",
  requestId: "request",
};
const content = new TextEncoder().encode("%PDF-1.7\n");
const file = {
  id: "pdf",
  content,
  size_bytes: content.length,
  file_name: "signed-lease-pdf.pdf",
};

test("authorized PDF response audits exactly once with identifiers only", async () => {
  const calls: SignedPdfDownloadAudit[] = [];
  const order: string[] = [];
  const response = await tenantSignedPdfDownload(event, {
    read: async () => {
      order.push("read");
      return file;
    },
    audit: async (entry) => {
      order.push("audit");
      calls.push(entry);
    },
    logError: () => assert.fail("unexpected audit error"),
  });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("Content-Type"), "application/pdf");
  assert.equal(response.headers.get("Content-Length"), String(content.length));
  assert.equal(response.headers.get("Cache-Control"), "private, no-store");
  assert.equal(response.headers.get("X-Content-Type-Options"), "nosniff");
  assert.equal(response.headers.get("Content-Disposition"),
    'attachment; filename="signed-lease-pdf.pdf"');
  assert.deepEqual(new Uint8Array(await response.arrayBuffer()), content);
  assert.deepEqual(order, ["read", "audit"]);
  assert.deepEqual(calls, [event]);
  assert.equal(JSON.stringify(calls).includes("%PDF"), false);
});

test("missing or RLS-hidden PDF returns 404 without auditing", async () => {
  const response = await tenantSignedPdfDownload(event, {
    read: async () => null,
    audit: async () => assert.fail("must not audit a missing PDF"),
    logError: () => assert.fail("unexpected audit error"),
  });
  assert.equal(response.status, 404);
  assert.equal(response.headers.get("Cache-Control"), "private, no-store");
});

test("denied or failed database read never audits", async () => {
  const error = new Error("permission denied");
  await assert.rejects(tenantSignedPdfDownload(event, {
    read: async () => { throw error; },
    audit: async () => assert.fail("must not audit a denied read"),
    logError: () => assert.fail("read errors belong to the query layer"),
  }), (caught) => caught === error);
});

test("response construction must succeed before auditing", async () => {
  await assert.rejects(tenantSignedPdfDownload(event, {
    read: async () => ({ ...file, file_name: "\ud800" }),
    audit: async () => assert.fail("must not audit a failed response"),
    logError: () => assert.fail("unexpected audit error"),
  }), URIError);
});

test("audit failure returns a private error without the PDF or sensitive log details", async () => {
  const error = new Error("audit unavailable");
  const logged: unknown[][] = [];
  let attempts = 0;
  const response = await tenantSignedPdfDownload(event, {
    read: async () => file,
    audit: async () => {
      attempts++;
      throw error;
    },
    logError: (tag, caught) => { logged.push([tag, caught]); },
  });
  assert.equal(attempts, 1);
  assert.equal(logged.length, 1);
  assert.equal(logged[0][0], "signed_pdf_download_audit");
  assert.notEqual(logged[0][1], error);
  assert.equal((logged[0][1] as Error).message, "Signed PDF audit unavailable");
  assert.equal(response.status, 503);
  assert.equal(response.headers.get("Cache-Control"), "private, no-store");
  assert.equal(response.headers.get("X-Content-Type-Options"), "nosniff");
  assert.equal(response.headers.get("Content-Disposition"), null);
  assert.equal(await response.text(), "Unavailable");
});

test("each successful request gets one event with its own request ID", async () => {
  const calls: SignedPdfDownloadAudit[] = [];
  for (const requestId of ["request-1", "request-2"]) {
    await tenantSignedPdfDownload({ ...event, requestId }, {
      read: async () => file,
      audit: async (entry) => { calls.push(entry); },
      logError: () => assert.fail("unexpected audit error"),
    });
  }
  assert.deepEqual(calls.map((entry) => entry.requestId),
    ["request-1", "request-2"]);
});
