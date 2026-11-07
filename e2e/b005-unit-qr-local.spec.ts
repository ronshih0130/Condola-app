import { test, expect, type Page } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { query } from "../src/server/db";
import { resetAndSeed } from "../src/server/seed";
import { ORG_ID, USERS } from "../src/server/ids";
import { issueUnitQr, UNIT_QR_COOKIE, unitQrHash } from "../src/server/unit-qr-signup";
import { disposableDbUrl } from "../src/server/test-disposable-db";
import { confirmSignupToken } from "../src/server/signup";
import { SESSION_COOKIE } from "../src/server/auth";
import type { Session } from "../src/server/types";

const origin = "http://127.0.0.1:43125";
let session: Session;
let unit: string;

test.beforeEach(async ({ context }) => {
  disposableDbUrl(process.env.DATABASE_URL, process.env.CONDOLA_RLS_DISPOSABLE);
  await resetAndSeed();
  await query(`UPDATE platform_settings SET value=$1::jsonb WHERE key='unit_qr_signup'`, [JSON.stringify({ enabled: true, allowed_org_ids: [ORG_ID] })]);
  await query(`UPDATE organizations SET feature_flags=feature_flags || '{"unit_qr_signup":true}'::jsonb WHERE id=$1`, [ORG_ID]);
  unit = (await query(`SELECT id FROM units WHERE org_id=$1 AND archived_at IS NULL ORDER BY id LIMIT 1`, [ORG_ID])).rows[0].id;
  const sessionId = randomUUID();
  await query(`INSERT INTO auth_sessions(id,user_id,token_hash,expires_at) VALUES($1,$2,$3,now()+interval '1 hour')`, [sessionId, USERS.admin, unitQrHash(randomUUID())]);
  session = { userId: USERS.admin, sessionId, orgId: ORG_ID, liveOrgId: ORG_ID, environment: "live", kind: "staff", role: "admin", email: "", name: "", locale: "en", calendar: "gregorian", leaseId: null };
  await context.addCookies([{ name: "condola_locale", value: "en", url: origin }]);
  await context.route("**/*", route => {
    if (new URL(route.request().url()).origin !== origin) throw new Error("External browser request forbidden");
    return route.continue();
  });
});

async function scan(page: Page) {
  const qr = await issueUnitQr(session, unit, origin);
  expect(qr).not.toBeNull();
  await page.goto(qr!.url);
  await expect(page).toHaveURL(`${origin}/signup`);
  await expect(page.getByTestId("unit-qr-signup-hint")).toBeVisible();
  return qr!;
}
async function fill(page: Page, email: string) {
  // A fast loopback navigation can beat hydration: wait for React to attach
  // the existing consent handler before a real user check, without changing
  // the legacy OFF form or forcing an otherwise-disabled submit button.
  await page.waitForFunction(() => {
    const input = document.querySelector('[data-testid="signup-consent"]');
    return input && Object.keys(input).some(key => key.startsWith("__reactProps$"));
  });
  await page.getByTestId("signup-email").fill(email);
  await page.getByTestId("signup-password").fill("Fresh1234");
  await page.getByTestId("signup-confirm").fill("Fresh1234");
  await page.getByTestId("signup-consent").check();
}

test("fragment never enters request URLs, analytics, errors or history; bind clears handle for a second account", async ({ page, context }) => {
  const urls: string[] = [], errors: string[] = [], referers: string[] = [];
  page.on("request", request => { urls.push(request.url()); referers.push(request.headers().referer || ""); });
  page.on("console", message => errors.push(message.text()));
  page.on("pageerror", error => errors.push(error.message));
  const qr = await scan(page);
  const token = new URLSearchParams(new URL(qr.url).hash.slice(1)).get("t")!;
  expect(JSON.stringify([urls, errors, referers])).not.toContain(token);
  const devtools = await context.newCDPSession(page);
  const history = await devtools.send("Page.getNavigationHistory");
  expect(JSON.stringify(history.entries)).not.toContain(token);
  await devtools.detach();
  expect(urls.filter(url => url.includes("/api/signup/unit-qr"))).toEqual([`${origin}/api/signup/unit-qr`]);
  const cookie = (await context.cookies()).find(cookie => cookie.name === UNIT_QR_COOKIE)!;
  expect(cookie.path).toBe("/signup"); expect(cookie.httpOnly).toBe(true);
  expect((await context.cookies(`${origin}/m`)).some(cookie => cookie.name === UNIT_QR_COOKIE)).toBe(false);
  const first = `${randomUUID()}@example.invalid`;
  await fill(page, first);
  await page.getByTestId("signup-submit").click();
  await expect(page).toHaveURL(/\/signup\/verify\?/);
  expect((await context.cookies()).some(cookie => cookie.name === UNIT_QR_COOKIE)).toBe(false);
  const firstId = (await query(`SELECT id FROM auth.users WHERE email=$1`, [first])).rows[0].id;
  expect((await query(`SELECT user_id FROM app.b005_unit_qr_contexts WHERE id=$1`, [qr.id])).rows[0].user_id).toBe(firstId);
  // Complete with the real account-bound continuation, after the browser handle is gone.
  const verification = new URL(page.url()).searchParams.get("dev")!;
  const confirmed = await confirmSignupToken(verification, { ua: "local-browser", ip: "127.0.0.1" });
  expect(confirmed.ok).toBe(true);
  if (!confirmed.ok) throw new Error("Confirmation failed");
  await context.addCookies([{ name: SESSION_COOKIE, value: confirmed.token, url: origin }]);
  await page.goto("/signup/firm");
  await page.locator('[name="contactName"]').fill("Browser applicant");
  await page.locator('[name="phone"]').fill("+14155550123");
  await page.getByRole("button", { name: "Submit application", exact: true }).click();
  await expect(page.getByRole("status")).toContainText("Application submitted");
  expect((await context.cookies()).some(cookie => cookie.name === UNIT_QR_COOKIE)).toBe(false);
  await context.clearCookies({ name: SESSION_COOKIE });
  await page.goto("/signup");
  const second = `${randomUUID()}@example.invalid`;
  await fill(page, second);
  await page.getByTestId("signup-submit").click();
  await expect(page).toHaveURL(/\/signup\/verify\?/);
  const secondId = (await query(`SELECT id FROM auth.users WHERE email=$1`, [second])).rows[0].id;
  expect(secondId).not.toBe(firstId);
  expect((await query(`SELECT 1 FROM app.b005_unit_qr_contexts WHERE user_id=$1`, [secondId])).rowCount).toBe(0);
  expect(JSON.stringify([urls, errors, referers])).not.toContain(token);
  // Back navigation must never revisit a bearer URL or re-exchange it.
  await page.goBack();
  expect(page.url()).not.toContain(token);
  expect(urls.filter(url => url.includes("/api/signup/unit-qr"))).toHaveLength(1);
});

test("expiry, revocation, archive and browser-cookie expiry while the form is open fail closed; abandon clears it", async ({ page, context }) => {
  for (const mode of ["expire", "revoke", "archive", "cookie"]) {
    const qr = await scan(page);
    const email = `${randomUUID()}@example.invalid`;
    await fill(page, email);
    if (mode === "expire") await query(`UPDATE app.b005_unit_qr_contexts SET created_at=now()-interval '1 hour',expires_at=now()-interval '30 minutes' WHERE id=$1`, [qr.id]);
    if (mode === "revoke") await query(`UPDATE app.b005_unit_qr_contexts SET revoked_at=now() WHERE id=$1`, [qr.id]);
    if (mode === "archive") await query(`UPDATE units SET archived_at=now() WHERE id=$1`, [unit]);
    if (mode === "cookie") await context.clearCookies({ name: UNIT_QR_COOKIE });
    await page.getByTestId("signup-submit").click();
    await expect(page).toHaveURL(`${origin}/signup?error=required`);
    expect((await query(`SELECT 1 FROM auth.users WHERE email=$1`, [email])).rowCount).toBe(0);
    if (mode !== "cookie") {
      await expect(page.locator(".auth-wrap").getByRole("alert")).toContainText("If the link has expired");
      await page.getByRole("button", { name: "Leave this application" }).click();
      await expect(page).toHaveURL(`${origin}/signup`);
      expect((await context.cookies()).some(cookie => cookie.name === UNIT_QR_COOKIE)).toBe(false);
    }
    await query(`UPDATE units SET archived_at=NULL WHERE id=$1`, [unit]);
  }
});

test("disabled continuation renders byte-identical ordinary signup DOM and submits without binding", async ({ page, context }) => {
  await page.goto("/signup");
  await expect(page.getByTestId("signup-submit")).toBeVisible();
  const ordinary = await page.locator(".auth-wrap").evaluate(element => element.outerHTML);
  const qr = await scan(page);
  await query(`UPDATE platform_settings SET value='{"enabled":false,"allowed_org_ids":[]}'::jsonb WHERE key='unit_qr_signup'`);
  await page.goto("/signup");
  await expect(page.getByTestId("signup-submit")).toBeVisible();
  expect(await page.locator(".auth-wrap").evaluate(element => element.outerHTML)).toBe(ordinary);
  const before = (await query(`SELECT to_jsonb(c) AS row FROM app.b005_unit_qr_contexts c WHERE id=$1`, [qr.id])).rows[0].row;
  await fill(page, `${randomUUID()}@example.invalid`);
  await page.getByTestId("signup-submit").click();
  await expect(page).toHaveURL(/\/signup\/verify\?/);
  expect((await query(`SELECT to_jsonb(c) AS row FROM app.b005_unit_qr_contexts c WHERE id=$1`, [qr.id])).rows[0].row).toEqual(before);
  // Disabled-feature behavior does not introduce a cookie mutation.
  expect((await context.cookies()).some(cookie => cookie.name === UNIT_QR_COOKIE)).toBe(true);
});
