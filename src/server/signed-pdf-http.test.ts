import assert from "node:assert/strict";
import test from "node:test";
import type { Session } from "./types";
import { legacyStaffSignedPdfHttp, staffSignedPdfHttp, tenantSignedPdfHttp } from "./signed-pdf-http";

const org = "00000000-0000-4000-8000-000000000010";
const other = "00000000-0000-4000-8000-000000000011";
const lease = "00000000-0000-4000-8000-000000000012";
const pdf = "00000000-0000-4000-8000-000000000013";
const bytes = new TextEncoder().encode("%PDF-1.7\n");

function session(overrides: Partial<Session> = {}): Session {
  return {
    userId: "00000000-0000-4000-8000-000000000001",
    sessionId: "00000000-0000-4000-8000-000000000002",
    email: "person@example.com",
    name: "Person",
    kind: "tenant",
    role: null,
    orgId: org,
    liveOrgId: org,
    environment: "live",
    locale: "en",
    calendar: "gregorian",
    leaseId: lease,
    consent: {
      accepted_at: "2026-10-30T00:00:00.000Z",
      terms_version: "2026-10-22",
      privacy_version: "2026-10-29",
      source: "reconsent",
    },
    partnerConsent: { active: false, required: false, admin: false, documents: [] },
    ...overrides,
  };
}

test("tenant signed-PDF HTTP refuses logged-out, missing consent, and another organization", async () => {
  let reads = 0;
  let audits = 0;
  const read = async () => {
    reads += 1;
    return { content: bytes, file_name: "lease.pdf" };
  };
  const audit = async () => {
    audits += 1;
  };
  const loggedOut = await tenantSignedPdfHttp({
    session: null, pdfId: pdf, leaseId: lease, leaseOrgId: org, globallyEnabled: true, read, audit, logError: () => assert.fail("log"),
  });
  assert.equal(loggedOut.status, 307);
  assert.equal(loggedOut.headers.get("Location"), "/login");
  const refused = await tenantSignedPdfHttp({
    session: session({ consent: null }), pdfId: pdf, leaseId: lease, leaseOrgId: org, globallyEnabled: true, read, audit, logError: () => assert.fail("log"),
  });
  assert.equal(refused.status, 403);
  const otherOrg = await tenantSignedPdfHttp({
    session: session(), pdfId: pdf, leaseId: lease, leaseOrgId: other, globallyEnabled: true, read, audit, logError: () => assert.fail("log"),
  });
  assert.equal(otherOrg.status, 404);
  assert.equal(reads, 0);
  assert.equal(audits, 0);
  const off = await tenantSignedPdfHttp({
    session: session(), pdfId: pdf, leaseId: lease, leaseOrgId: org, globallyEnabled: false, read, audit, logError: () => assert.fail("log"),
  });
  assert.equal(off.status, 404);
});

test("staff signed-PDF HTTP allows only admin or manager and writes an audit row", async () => {
  let reads = 0;
  let audits = 0;
  const read = async () => {
    reads += 1;
    return { content: bytes, file_name: "lease.pdf" };
  };
  const audit = async () => {
    audits += 1;
  };
  const base = {
    leaseId: lease, pdfId: pdf, leaseOrgId: org, globallyEnabled: true, read, audit, logError: () => assert.fail("log"),
  };
  const loggedOut = await staffSignedPdfHttp({ ...base, session: null });
  assert.equal(loggedOut.status, 307);
  assert.equal(loggedOut.headers.get("Location"), "/login");
  const refused = await staffSignedPdfHttp({ ...base, session: session({ kind: "staff", role: "admin", consent: null }) });
  assert.equal(refused.status, 403);
  const accountant = await staffSignedPdfHttp({ ...base, session: session({ kind: "staff", role: "accountant" }) });
  assert.equal(accountant.status, 404);
  const otherOrg = await staffSignedPdfHttp({ ...base, leaseOrgId: other, session: session({ kind: "staff", role: "manager" }) });
  assert.equal(otherOrg.status, 404);
  assert.equal(reads, 0);
  assert.equal(audits, 0);
  const ok = await staffSignedPdfHttp({ ...base, session: session({ kind: "staff", role: "admin" }) });
  assert.equal(ok.status, 200);
  assert.equal(ok.headers.get("Cache-Control"), "private, no-store");
  assert.equal(reads, 1);
  assert.equal(audits, 1);
});

test("legacy staff signed-PDF HTTP redirects logged-out requests without touching storage", async () => {
  let reads = 0;
  let audits = 0;
  const read = async () => {
    reads += 1;
    return { id: pdf, content: bytes, file_name: "lease.pdf" };
  };
  const audit = async () => {
    audits += 1;
  };
  const res = await legacyStaffSignedPdfHttp({
    session: null, leaseId: lease, read, audit, logError: () => assert.fail("log"),
  });
  assert.equal(res.status, 307);
  assert.equal(res.headers.get("Location"), "/login");
  assert.equal(reads, 0);
  assert.equal(audits, 0);
});

test("legacy staff signed-PDF HTTP hides the lease from accountants", async () => {
  let reads = 0;
  let audits = 0;
  const read = async () => {
    reads += 1;
    return { id: pdf, content: bytes, file_name: "lease.pdf" };
  };
  const audit = async () => {
    audits += 1;
  };
  const res = await legacyStaffSignedPdfHttp({
    session: session({ kind: "staff", role: "accountant", leaseId: undefined }), leaseId: lease, read, audit, logError: () => assert.fail("log"),
  });
  assert.equal(res.status, 404);
  assert.equal(res.headers.get("Cache-Control"), "private, no-store");
  assert.equal(res.headers.get("X-Content-Type-Options"), "nosniff");
  const body = await res.text();
  assert.equal(body, "Not found");
  assert.ok(!body.startsWith("%PDF"));
  assert.equal(reads, 0);
  assert.equal(audits, 0);
});

test("legacy staff signed-PDF HTTP hides the lease from maintenance staff", async () => {
  let reads = 0;
  let audits = 0;
  const read = async () => {
    reads += 1;
    return { id: pdf, content: bytes, file_name: "lease.pdf" };
  };
  const audit = async () => {
    audits += 1;
  };
  const res = await legacyStaffSignedPdfHttp({
    session: session({ kind: "staff", role: "maintenance", leaseId: undefined }), leaseId: lease, read, audit, logError: () => assert.fail("log"),
  });
  assert.equal(res.status, 404);
  assert.equal(res.headers.get("Cache-Control"), "private, no-store");
  assert.equal(res.headers.get("X-Content-Type-Options"), "nosniff");
  const body = await res.text();
  assert.ok(!body.startsWith("%PDF"));
  assert.equal(reads, 0);
  assert.equal(audits, 0);
});

test("legacy staff signed-PDF HTTP rejects the tenant portal session", async () => {
  let reads = 0;
  const read = async () => {
    reads += 1;
    return { id: pdf, content: bytes, file_name: "lease.pdf" };
  };
  const res = await legacyStaffSignedPdfHttp({
    session: session(), leaseId: lease, read, audit: async () => assert.fail("audit"), logError: () => assert.fail("log"),
  });
  assert.equal(res.status, 404);
  assert.equal(reads, 0);
});

test("legacy staff signed-PDF HTTP requires current consent even for admins", async () => {
  let reads = 0;
  const read = async () => {
    reads += 1;
    return { id: pdf, content: bytes, file_name: "lease.pdf" };
  };
  const res = await legacyStaffSignedPdfHttp({
    session: session({ kind: "staff", role: "admin", leaseId: undefined, consent: null }), leaseId: lease, read, audit: async () => assert.fail("audit"), logError: () => assert.fail("log"),
  });
  assert.equal(res.status, 403);
  assert.equal(reads, 0);
});

test("legacy staff signed-PDF HTTP rejects a malformed lease id before reading", async () => {
  let reads = 0;
  const read = async () => {
    reads += 1;
    return { id: pdf, content: bytes, file_name: "lease.pdf" };
  };
  const res = await legacyStaffSignedPdfHttp({
    session: session({ kind: "staff", role: "admin", leaseId: undefined }), leaseId: "not-a-uuid", read, audit: async () => assert.fail("audit"), logError: () => assert.fail("log"),
  });
  assert.equal(res.status, 404);
  assert.equal(reads, 0);
});

test("legacy staff signed-PDF HTTP returns 404 when the read finds nothing", async () => {
  let audits = 0;
  const read = async () => null;
  const audit = async () => {
    audits += 1;
  };
  const res = await legacyStaffSignedPdfHttp({
    session: session({ kind: "staff", role: "admin", leaseId: undefined }), leaseId: lease, read, audit, logError: () => assert.fail("log"),
  });
  assert.equal(res.status, 404);
  assert.equal(audits, 0);
});

test("legacy staff signed-PDF HTTP serves the PDF to admins and audits the download", async () => {
  let audits = 0;
  let auditedPdfId: string | null = null;
  const read = async () => ({ id: pdf, content: bytes, file_name: "lease.pdf" });
  const audit = async (pdfId: string) => {
    audits += 1;
    auditedPdfId = pdfId;
  };
  const res = await legacyStaffSignedPdfHttp({
    session: session({ kind: "staff", role: "admin", leaseId: undefined }), leaseId: lease, read, audit, logError: () => assert.fail("log"),
  });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("Content-Type"), "application/pdf");
  assert.match(res.headers.get("Content-Disposition") ?? "", /attachment/);
  assert.equal(res.headers.get("Content-Length"), String(bytes.length));
  assert.equal(res.headers.get("Cache-Control"), "private, no-store");
  const body = new Uint8Array(await res.arrayBuffer());
  assert.deepEqual(body, bytes);
  assert.equal(audits, 1);
  assert.equal(auditedPdfId, pdf);
});

test("legacy staff signed-PDF HTTP serves the PDF to managers and audits once", async () => {
  let audits = 0;
  const read = async () => ({ id: pdf, content: bytes, file_name: "lease.pdf" });
  const audit = async () => {
    audits += 1;
  };
  const res = await legacyStaffSignedPdfHttp({
    session: session({ kind: "staff", role: "manager", leaseId: undefined }), leaseId: lease, read, audit, logError: () => assert.fail("log"),
  });
  assert.equal(res.status, 200);
  assert.equal(audits, 1);
});

test("legacy staff signed-PDF HTTP fails closed with 503 and no bytes when the audit write throws", async () => {
  let logs = 0;
  const read = async () => ({ id: pdf, content: bytes, file_name: "lease.pdf" });
  const audit = async () => {
    throw new Error("audit down");
  };
  const res = await legacyStaffSignedPdfHttp({
    session: session({ kind: "staff", role: "admin", leaseId: undefined }), leaseId: lease, read, audit, logError: () => {
      logs += 1;
    },
  });
  assert.equal(res.status, 503);
  assert.equal(res.headers.get("Cache-Control"), "private, no-store");
  const body = await res.text();
  assert.ok(!body.startsWith("%PDF"));
  assert.equal(logs, 1);
});
