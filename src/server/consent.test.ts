import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  CONSENT_WRITE_SQL,
  buildStoredConsent,
  consentAdminBody,
  consentCoversCurrent,
  deliverConsent,
  effectiveConsent,
  parseAppConsent,
  type ConsentRepository,
  type StoredConsent,
} from "./consent";
import { consentGateTarget, entryConsentRedirect, passConsentGate, teamInviteBlocked } from "./consent-gate";
import { PRIVACY_VERSION, TERMS_VERSION } from "./legal-versions";
import { createFirm } from "./signup";

const userOnly = {
  terms_accepted_at: "2026-10-25T00:00:00.000Z",
  terms_version: TERMS_VERSION,
  privacy_version: PRIVACY_VERSION,
};

function memoryRepo(initial: StoredConsent | null) {
  let current = initial;
  const writes: StoredConsent[] = [];
  const repo: ConsentRepository = {
    async read() {
      return current;
    },
    async write(_userId, record) {
      writes.push(record);
      current = record;
    },
  };
  return { writes, repo };
}

test("app_metadata consent is current only for these legal versions", () => {
  const current = buildStoredConsent("signup", new Date("2026-10-25T07:00:00.000Z"));
  assert.equal(current.accepted_at, "2026-10-25T07:00:00.000Z");
  assert.equal(current.terms_version, TERMS_VERSION);
  assert.equal(current.privacy_version, PRIVACY_VERSION);
  assert.equal(consentCoversCurrent(current), true);
  assert.equal(consentCoversCurrent({ ...current, terms_version: "2026-01-01" }), false);
  assert.equal(consentCoversCurrent({ ...current, privacy_version: "2026-10-21" }), false);
  assert.equal(consentCoversCurrent({ ...current, terms_version: "2026-12-01", privacy_version: "2026-12-01" }), false);
  assert.equal(consentCoversCurrent(null), false);
  assert.equal(parseAppConsent({ consent: { ...current, accepted_at: "not-a-date" } }), null);
  assert.equal(parseAppConsent({ consent: { ...current, source: "client" } }), null);
  assert.deepEqual(parseAppConsent({ provider: "email", consent: current }), current);
});

test("user_metadata-only consent counts as missing", async () => {
  assert.equal(effectiveConsent({}, userOnly), null);
  assert.equal(effectiveConsent(null, userOnly), null);
  const current = buildStoredConsent("signup", new Date("2026-10-25T07:00:00.000Z"));
  assert.deepEqual(effectiveConsent({ consent: current }, userOnly), current);
  const gate = await passConsentGate("user-1", "reconsent", false, {
    async read() {
      return effectiveConsent({}, userOnly);
    },
    async write() {
      throw new Error("should not write");
    },
  });
  assert.deepEqual(gate, { ok: false, error: "consent" });
});

test("the service-role write sends app_metadata and keeps user_metadata compatible", async () => {
  const record = buildStoredConsent("reconsent", new Date("2026-10-25T08:00:00.000Z"));
  let url = "";
  let auth = "";
  let body = "";
  const via = await deliverConsent("user-1", record, {
    admin: { url: "https://example.supabase.co", service: "service-key" },
    fetchImpl: async (input, init) => {
      url = String(input);
      const headers = new Headers(init?.headers);
      auth = headers.get("authorization") || "";
      body = String(init?.body ?? "");
      return new Response("{}", { status: 200 });
    },
    sql: async () => {
      throw new Error("sql should not run");
    },
  });
  assert.equal(via, "admin");
  assert.equal(url, "https://example.supabase.co/auth/v1/admin/users/user-1");
  assert.equal(auth, "Bearer service-key");
  const parsed = JSON.parse(body) as ReturnType<typeof consentAdminBody> & { password?: string };
  assert.deepEqual(parsed.app_metadata.consent, record);
  assert.equal(parsed.user_metadata.terms_accepted_at, record.accepted_at);
  assert.equal(parsed.user_metadata.terms_version, TERMS_VERSION);
  assert.equal(parsed.user_metadata.privacy_version, PRIVACY_VERSION);
  assert.equal("source" in parsed.user_metadata, false);
  assert.equal("password" in parsed, false);
  assert.match(CONSENT_WRITE_SQL, /jsonb_set\(coalesce\(raw_app_meta_data/);
  assert.match(CONSENT_WRITE_SQL, /raw_user_meta_data/);

  let sqlRecord: StoredConsent | null = null;
  const failed = await deliverConsent("user-1", record, {
    admin: { url: "https://example.supabase.co", service: "service-key" },
    fetchImpl: async () => new Response("no", { status: 500 }),
    sql: async (_id, row) => {
      sqlRecord = row;
    },
  });
  assert.equal(failed, "sql");
  assert.deepEqual(sqlRecord, record);

  let threw = false;
  const offline = await deliverConsent("user-1", record, {
    admin: { url: "https://example.supabase.co", service: "service-key" },
    fetchImpl: async () => {
      threw = true;
      throw new Error("offline");
    },
    sql: async () => undefined,
  });
  assert.equal(threw, true);
  assert.equal(offline, "sql");

  const local = await deliverConsent("user-1", record, {
    admin: null,
    fetchImpl: async () => {
      throw new Error("no admin");
    },
    sql: async () => undefined,
  });
  assert.equal(local, "sql");
});

test("creating a company rejects a missing checkbox when app_metadata consent is absent", async () => {
  const bucket = memoryRepo(null);
  const result = await createFirm({
    userId: "user-1",
    email: "owner@example.com",
    kind: "firm",
    name: "北門",
    contactName: "林",
    phone: "0912000000",
    partnerCode: "",
    consent: false,
    consentRepo: bucket.repo,
  });
  assert.deepEqual(result, { ok: false, error: "consent" });
  assert.equal(bucket.writes.length, 0);
});

test("login re-consent rejects a missing or older checkbox tick and records a fresh one", async () => {
  const missing = memoryRepo(null);
  const blocked = await passConsentGate("user-1", "reconsent", false, missing.repo);
  assert.deepEqual(blocked, { ok: false, error: "consent" });
  assert.equal(consentGateTarget(null, "reconsent", "/auth/continue"), "/consent?next=%2Fauth%2Fcontinue");
  const stale = buildStoredConsent("signup", new Date("2026-01-01T00:00:00.000Z"));
  stale.terms_version = "2026-01-01";
  const older = memoryRepo(stale);
  const stillBlocked = await entryConsentRedirect("user-1", "reconsent", "/m", older.repo);
  assert.equal(stillBlocked, "/consent?next=%2Fm");
  const saved = await passConsentGate("user-1", "reconsent", true, older.repo);
  assert.equal(saved.ok, true);
  assert.equal(older.writes.length, 1);
  assert.equal(older.writes[0].source, "reconsent");
  assert.equal(older.writes[0].terms_version, TERMS_VERSION);
  assert.equal(older.writes[0].privacy_version, PRIVACY_VERSION);
  assert.match(older.writes[0].accepted_at, /^\d{4}-\d{2}-\d{2}T/);
  const again = await passConsentGate("user-1", "reconsent", false, older.repo);
  assert.deepEqual(again, { ok: true, recorded: false });
  assert.equal(older.writes.length, 1);
});

test("portal entry rejects a missing checkbox and records source portal", async () => {
  const bucket = memoryRepo(null);
  assert.equal(await entryConsentRedirect("user-1", "portal", "/o", bucket.repo), "/consent/portal?next=%2Fo");
  assert.equal(await entryConsentRedirect("user-1", "portal", "/t", bucket.repo), "/consent/portal?next=%2Ft");
  const blocked = await passConsentGate("user-1", "portal", false, bucket.repo);
  assert.deepEqual(blocked, { ok: false, error: "consent" });
  assert.equal(bucket.writes.length, 0);
  const saved = await passConsentGate("user-1", "portal", true, bucket.repo);
  assert.equal(saved.ok, true);
  assert.equal(bucket.writes[0].source, "portal");
  assert.equal(consentGateTarget(bucket.writes[0], "portal", "/o"), null);
});

test("team invite rejects a missing checkbox before a user is written", () => {
  assert.equal(teamInviteBlocked("team_member", false), true);
  assert.equal(teamInviteBlocked("team_member", undefined), true);
  assert.equal(teamInviteBlocked("team_member", true), false);
  assert.equal(teamInviteBlocked("owner", false), false);
  assert.equal(teamInviteBlocked("tenant", false), false);
  const auth = readFileSync(new URL("./auth.ts", import.meta.url), "utf8");
  const once = auth.slice(auth.indexOf("async function acceptInviteOnce"), auth.indexOf("export async function listSessions"));
  const blockedAt = once.indexOf("teamInviteBlocked");
  const userAt = once.indexOf("upsertInvitedUser");
  const writeAt = once.indexOf('writeConsent(userId, "invite")');
  const sessionAt = once.indexOf("createSession(userId, true, meta)");
  assert.ok(blockedAt > 0 && userAt > blockedAt, "consent is rejected before the login is written");
  assert.ok(writeAt > userAt && sessionAt > writeAt, "invite consent is stored before the session");
  const actions = readFileSync(new URL("./auth-actions.ts", import.meta.url), "utf8");
  assert.match(actions, /formData\.get\("consent"\) === "on"/);
});

test("each gate calls the server helper before the protected action", () => {
  const signup = readFileSync(new URL("./signup.ts", import.meta.url), "utf8");
  const firm = signup.slice(signup.indexOf("export async function createFirm"), signup.length);
  assert.ok(firm.indexOf("passConsentGate") < firm.indexOf("INSERT INTO organizations"));
  assert.match(firm, /"reconsent"/);
  const actions = readFileSync(new URL("./consent-actions.ts", import.meta.url), "utf8");
  assert.match(actions, /passConsentGate\(identity\.user_id, "reconsent"/);
  assert.match(actions, /passConsentGate\(session\.userId, "portal"/);
  assert.match(actions, /if \(!gate\.ok\) redirect/);
  const enter = readFileSync(new URL("../app/api/auth/enter/route.ts", import.meta.url), "utf8");
  const enterPage = readFileSync(new URL("../app/auth/enter/page.tsx", import.meta.url), "utf8");
  assert.match(enter, /resolveEntryLocation/);
  assert.match(enterPage, /resolveEntryLocation/);
  assert.match(readFileSync(new URL("./sign-out.ts", import.meta.url), "utf8"), /\/auth\/enter\?next=/);
  const manager = readFileSync(new URL("../app/m/layout.tsx", import.meta.url), "utf8");
  const owner = readFileSync(new URL("../app/o/layout.tsx", import.meta.url), "utf8");
  const tenant = readFileSync(new URL("../app/t/layout.tsx", import.meta.url), "utf8");
  assert.match(manager, /entryConsentRedirect\(session\.userId, "reconsent"/);
  assert.match(owner, /entryConsentRedirect\(session\.userId, "portal"/);
  assert.match(tenant, /entryConsentRedirect\(session\.userId, "portal"/);
  const signupStart = signup.slice(signup.indexOf("export async function startSignup"), signup.indexOf("export async function resendSignup"));
  assert.match(signupStart, /writeConsent\([^)]*"signup"/);
});
