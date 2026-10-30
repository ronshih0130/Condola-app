import "./partner-consent.test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import type { Client } from "pg";
import { buildStoredConsent, loadConsentRow, persistConsent, withMissingConsentFallback } from "./consent";
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
      if (query.includes("SELECT accepted_at")) sql = query;
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

test("missing consents fails closed, recovers the read transaction and logs once without identifiers", async () => {
  const missing = Object.assign(new Error('relation "public.consents" does not exist'), { code: "42P01" });
  const statements: string[] = [];
  const service = (async (_id: unknown, run: (client: Client) => Promise<unknown>) =>
    run({ query: async (sql: string) => {
      statements.push(sql);
      if (sql.includes("SELECT accepted_at")) throw missing;
      return { rows: [] };
    } } as unknown as Client)) as typeof svc;
  const logged: unknown[][] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => { logged.push(args); };
  try {
    for (let attempt = 0; attempt < 2; attempt++) {
      assert.equal(await loadConsentRow("private-user", service), null);
      assert.equal((await requireCurrentConsent(session("staff", null), "api"))?.status, 403);
    }
    const identity = { rows: [{ user_id: "private-user", consent: null }] };
    assert.equal(await withMissingConsentFallback(
      async () => { throw missing; },
      async () => identity,
    ), identity);
  } finally {
    console.error = original;
  }
  assert.deepEqual(logged, [["public.consents unavailable; consent required"]]);
  assert.equal(statements.filter((sql) => sql === "ROLLBACK TO SAVEPOINT consent_read").length, 2);
  assert.equal(statements.filter((sql) => sql === "RELEASE SAVEPOINT consent_read").length, 2);

  for (const failure of [
    Object.assign(new Error('relation "auth.users" does not exist'), { code: "42P01" }),
    Object.assign(new Error('relation "public.consents" does not exist'), { code: "42501" }),
    new Error("connection terminated"),
  ]) {
    await assert.rejects(withMissingConsentFallback(
      async () => { throw failure; },
      async () => { throw new Error("unexpected fallback"); },
    ), (error) => error === failure);
    const failingService = (async (_id: unknown, run: (client: Client) => Promise<unknown>) =>
      run({ query: async (sql: string) => {
        if (sql.includes("SELECT accepted_at")) throw failure;
        return { rows: [] };
      } } as unknown as Client)) as typeof svc;
    await assert.rejects(loadConsentRow("private-user", failingService), (error) => error === failure);
  }
});

test("missing-table acceptance propagates the existing controlled write error", async () => {
  const { FlowError } = await import("./errors");
  const unavailable = new FlowError("errors.generic");
  let inserts = 0;
  const service = (async (_id: unknown, run: (client: Client) => Promise<unknown>) => {
    try {
      return await run({ query: async (sql: string) => {
        assert.match(sql, /INSERT INTO public.consents/);
        inserts++;
        throw Object.assign(new Error('relation "public.consents" does not exist'), { code: "42P01" });
      } } as unknown as Client);
    } catch {
      // svc maps a failed INSERT to the existing controlled database error.
      throw unavailable;
    }
  }) as typeof svc;
  await assert.rejects(passConsentGate("user", "portal", true, {
    read: async () => null,
    write: (id, record) => persistConsent(id, record, service),
  }), (error) => error === unavailable);
  assert.equal(inserts, 1);
});

test("session fallback retries identity without the lateral consent join", () => {
  const source = readFileSync(new URL("./session.ts", import.meta.url), "utf8");
  const lookup = source.slice(source.indexOf("const found ="), source.indexOf("const identity ="));
  assert.match(lookup, /withMissingConsentFallback/);
  assert.match(lookup, /LEFT JOIN LATERAL/);
  const fallback = lookup.slice(lookup.indexOf("NULL::jsonb AS consent"));
  assert.match(fallback, /FROM auth_sessions s/);
  assert.match(fallback, /JOIN auth\.users u ON u\.id = s\.user_id/);
  assert.match(fallback, /s\.revoked_at IS NULL AND s\.expires_at > now\(\)/);
  assert.doesNotMatch(fallback, /public\.consents|LATERAL|raw_app_meta_data|raw_user_meta_data/);
});

test("Class B notes allow session touching as authentication bookkeeping", () => {
  const source = readFileSync(new URL("./consent-gate.ts", import.meta.url), "utf8");
  assert.match(source, /Class B notes: session touching \(last_active_at and expiry extension\) is\s+\* allowed authentication bookkeeping before this gate/);
  assert.match(source, /Business mutations\s+\* and sandbox provisioning still require current consent/);
});
