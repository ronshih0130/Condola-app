import assert from "node:assert/strict";
import test from "node:test";
import type { Client } from "pg";
import { buildStoredConsent, loadConsentRow, persistConsent } from "./consent";
import { consentNextPath, passConsentGate, requireCurrentConsent } from "./consent-gate";
import { svc } from "./db";
import type { Session } from "./types";

const current = buildStoredConsent("reconsent");
function session(kind: Session["kind"], consent: Session["consent"]): Session {
  return {
    userId: "00000000-0000-4000-8000-000000000001", sessionId: "test",
    kind, consent, email: "test@example.com", name: "Test", role: kind === "staff" ? "admin" : null,
    orgId: "", liveOrgId: "", environment: "live", locale: "en", calendar: "gregorian", leaseId: null,
  };
}
for (const [name, consent] of [
  ["missing", null],
  ["stale terms", { ...current, terms_version: "old" }],
  ["stale privacy", { ...current, privacy_version: "old" }],
] as const) {
  test(name + " returns the exact private API denial", async () => {
    const response = await requireCurrentConsent(session("staff", consent), "api");
    assert.ok(response);
    assert.equal(response.status, 403);
    assert.equal(response.headers.get("cache-control"), "private, no-store");
    assert.deepEqual(await response.json(), { ok: false, error: "errors.consentRequired" });
  });
}
test("current table evidence permits API and action access", async () => {
  for (const kind of ["staff", "owner", "tenant"] as const) {
    assert.equal(await requireCurrentConsent(session(kind, current), "api"), null);
    assert.equal(await requireCurrentConsent(session(kind, current), "action", "/m"), null);
  }
});
for (const kind of ["staff", "owner", "tenant"] as const) {
  for (const mode of ["action", "page"] as const) {
    test(kind + " " + mode + " redirects through the correct consent page", async () => {
      const next = kind === "staff" ? "/m/team?tab=all" : kind === "owner" ? "/o/statements" : "/t/messages";
      const base = kind === "staff" ? "/consent" : "/consent/portal";
      await assert.rejects(requireCurrentConsent(session(kind, null), mode, next), (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.equal((error as Error & { digest: string }).digest,
          "NEXT_REDIRECT;replace;" + base + "?next=" + encodeURIComponent(next) + ";307;");
        return true;
      });
    });
  }
}
test("malicious and recursive next paths are rejected by the real redirect guard", async () => {
  for (const value of ["https://evil.example/m", "//evil.example/m", "/consent", "/consent/portal", "/login"]) {
    assert.equal(consentNextPath(value, "/m"), "/m");
    await assert.rejects(requireCurrentConsent(session("staff", null), "action", value),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.equal((error as Error & { digest: string }).digest, "NEXT_REDIRECT;replace;/consent?next=%2Fm;307;");
        return true;
      });
  }
});
test("the repository selects the latest row, even when an older row matches", async () => {
  const stale = { ...current, terms_version: "old" };
  let sql = "";
  const service = (async (_id: unknown, run: (client: Client) => Promise<unknown>) =>
    run({ query: async (query: string) => {
      sql = query;
      return { rows: [stale, current] };
    } } as unknown as Client)) as typeof svc;
  const latest = await loadConsentRow("user", service);
  assert.match(sql, /ORDER BY recorded_at DESC, id DESC LIMIT 1/);
  assert.deepEqual(latest, stale);
  assert.equal((await requireCurrentConsent(session("staff", latest), "api"))?.status, 403);
});
test("persistConsent cannot report success or mirror metadata after a failed INSERT", async () => {
  const failure = new Error("table insert failed");
  let inserts = 0;
  const service = (async (_id: unknown, run: (client: Client) => Promise<unknown>) =>
    run({ query: async (sql: string) => {
      assert.match(sql, /INSERT INTO public.consents/);
      inserts++;
      throw failure;
    } } as unknown as Client)) as typeof svc;
  await assert.rejects(persistConsent("user", current, service), (error) => error === failure);
  assert.equal(inserts, 1);
  await assert.rejects(passConsentGate("user", "portal", true, {
    read: async () => null,
    write: (id, record) => persistConsent(id, record, service),
  }), (error) => error === failure);
  assert.equal(inserts, 2);
});
