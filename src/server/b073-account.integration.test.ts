import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test, { mock } from "node:test";
import { Client } from "pg";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import nextHeaders from "next/headers";
import { accountRead } from "./b073-account";
import { AccountSection } from "@/components/v3/m/settings/account-page";
import { sessionTokenHash } from "./session";
import { disposableDbUrl } from "./test-disposable-db";
import type { OrgRole, Session } from "./types";

// B-073 / R5-ACCT (MGT-137-AC1…AC4) against a disposable local database. Synthetic data only; nothing outbound.
disposableDbUrl(process.env.DATABASE_URL, process.env.CONDOLA_RLS_DISPOSABLE);
let db: Client;
const realFetch = globalThis.fetch;
let fetchCalls = 0;
test.before(async () => {
  db = new Client({ connectionString: process.env.DATABASE_URL }); await db.connect();
  globalThis.fetch = (async () => { fetchCalls += 1; throw new Error("B073: outbound fetch is forbidden"); }) as typeof fetch;
  mock.method(nextHeaders, "cookies", async () => ({ get: () => undefined }));
});
test.after(async () => { mock.restoreAll(); globalThis.fetch = realFetch; await db?.end(); assert.equal(fetchCalls, 0); });

const ROLES: OrgRole[] = ["admin", "manager", "accountant", "maintenance"];
/** Each role: its own phone shape, LINE link, MFA and live devices (plus a revoked and an expired one that never count). */
const FIXTURE: Record<string, { phone: string | null; masked: string | null; line: boolean; mfa: boolean; devices: number }> = {
  admin: { phone: "+886912345678", masked: "0912-•••-678", line: false, mfa: true, devices: 3 },
  manager: { phone: "+886933222111", masked: "0933-•••-111", line: true, mfa: false, devices: 1 },
  accountant: { phone: null, masked: null, line: false, mfa: false, devices: 2 },
  maintenance: { phone: "+14155550123", masked: "•••-•••-123", line: false, mfa: false, devices: 1 },
};
async function makeOrg() {
  const tag = `b073a.${randomUUID()}`;
  const orgId = (await db.query<{ id: string }>(
    `INSERT INTO organizations(name,country_code,default_currency,plan_tier,feature_flags)
     VALUES ($1,'TW','TWD','beta','{"brand_v2":true,"brand_v3":true}'::jsonb) RETURNING id`, [tag])).rows[0].id;
  const sessions: Record<string, Session> = {};
  for (const role of ROLES) {
    const f = FIXTURE[role];
    const email = `${tag}.${role}@example.com`;
    const userId = (await db.query<{ id: string }>(
      `INSERT INTO auth.users (id,email,raw_user_meta_data,email_confirmed_at,role,aud)
       VALUES (gen_random_uuid(), $1, '{}'::jsonb, now(), 'authenticated', 'authenticated') RETURNING id`, [email])).rows[0].id;
    await db.query(`INSERT INTO profiles(id,display_name,email,phone_e164,locale,line_linked) VALUES ($1,$2,$3,$4,'zh-TW',$5)
      ON CONFLICT (id) DO UPDATE SET phone_e164 = excluded.phone_e164, line_linked = excluded.line_linked`, [userId, `Synthetic ${role}`, email, f.phone, f.line]);
    await db.query("INSERT INTO org_members(org_id,user_id,role,status) VALUES ($1,$2,$3,'active')", [orgId, userId, role]);
    if (f.mfa) await db.query("INSERT INTO user_mfa(user_id,totp_secret,enabled,confirmed_at) VALUES ($1,'JBSWY3DPEHPK3PXP',true,now())", [userId]);
    const ids: string[] = [];
    for (let i = 0; i < f.devices; i++) {
      const id = (await db.query<{ id: string }>("INSERT INTO auth_sessions(user_id,token_hash,user_agent,ip,expires_at) VALUES ($1,$2,$3,$4,now()+interval '1 day') RETURNING id",
        [userId, sessionTokenHash(randomUUID()), `UA-${role}-${i}`, `IP-${role}-${i}`])).rows[0].id;
      ids.push(id);
    }
    await db.query("INSERT INTO auth_sessions(user_id,token_hash,expires_at,revoked_at) VALUES ($1,$2,now()+interval '1 day',now())", [userId, sessionTokenHash(randomUUID())]);
    await db.query("INSERT INTO auth_sessions(user_id,token_hash,expires_at) VALUES ($1,$2,now()-interval '1 minute')", [userId, sessionTokenHash(randomUUID())]);
    sessions[role] = { userId, orgId, liveOrgId: orgId, role, sessionId: ids[0], kind: "staff", environment: "live", locale: "zh-TW",
      calendar: "gregorian", leaseId: null, name: `Synthetic ${role}`, email };
  }
  return { orgId, sessions };
}

test("MGT-137-AC1 each staff role reads only its own account: masked phone, LINE, MFA and live device count", async () => {
  const { sessions } = await makeOrg();
  const other = await makeOrg();
  for (const role of ROLES) {
    const f = FIXTURE[role];
    const read = await accountRead(sessions[role], {}, { lineSupported: () => true });
    assert.equal(read.state, "ready", role);
    if (read.state !== "ready") continue;
    assert.equal(read.phone, f.masked, role);
    assert.equal(read.line, f.line, role);
    assert.deepEqual(read.mfa, { enabled: f.mfa, required: false }, role);
    assert.equal(read.devices.length, f.devices, role);
    for (const device of read.devices) assert.match(device.userAgent ?? "", new RegExp(`^UA-${role}-`), role);
    const json = JSON.stringify(read);
    // The full number never leaves the database; nobody else's data is in the answer.
    for (const r of ROLES) if (FIXTURE[r].phone) assert.ok(!json.includes(FIXTURE[r].phone!.slice(1)) && !json.includes(`0${FIXTURE[r].phone!.slice(4)}`), `${role} ${r}`);
    for (const r of ROLES.filter(x => x !== role)) assert.ok(!json.includes(`UA-${r}-`), `${role} sees ${r}`);
    assert.ok(!json.includes(other.sessions[role].userId));
  }
});

test("MGT-137 LINE: a live firm gets no LINE row from the real gate (the login page's demo gate)", async () => {
  const { sessions } = await makeOrg();
  const read = await accountRead(sessions.manager);
  assert.equal(read.state === "ready" && read.line, null);
});

test("MGT-137 the v3 page body against the database: own facts only, today's actions, no company-wide controls", async () => {
  const { sessions } = await makeOrg();
  // Today's client components (PasswordFields, PendingSubmit) compile with the classic JSX runtime under tsx.
  const runtime = globalThis as typeof globalThis & { React?: typeof React }; const previousReact = runtime.React; runtime.React = React;
  try { for (const role of ROLES) {
    const html = renderToStaticMarkup(await AccountSection({ session: sessions[role], params: {} }) as React.ReactElement);
    const f = FIXTURE[role];
    assert.match(html, /data-testid="account-v3"/, role);
    assert.ok(html.includes(sessions[role].email), role);
    if (f.masked) assert.ok(html.includes(f.masked), role); else assert.doesNotMatch(html, /account-phone/, role);
    assert.ok(html.includes(`登入中的裝置</span><span class="v3-acct-v">${f.devices} 台`), role);
    assert.ok(html.includes(`兩步驟驗證</span><span class="v3-acct-v">${f.mfa ? "已開啟" : "未開啟"}`), role);
    assert.doesNotMatch(html, /account-line|Google/, role);
    for (const r of ROLES.filter(x => x !== role)) assert.ok(!html.includes(sessions[r].email) && !html.includes(`UA-${r}-`), `${role} sees ${r}`);
    assert.doesNotMatch(html, /btn pri|require-mfa|name="require"|mail-lease|mail-overdue/, role);
    assert.equal(/data-testid="notify-moved"/.test(html), role === "admin" || role === "manager", role);
  } } finally { runtime.React = previousReact; }
});
