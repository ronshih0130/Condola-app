import { test, expect } from "@playwright/test";

test.beforeEach(async ({ context, baseURL }) => {
  const origin = new URL(baseURL!).origin;
  await context.route("**/*", route => {
    if (new URL(route.request().url()).origin !== origin) throw new Error("External browser request forbidden");
    return route.continue();
  });
});

const TOKEN = "a".repeat(43);
const RETIRED_HEADLINE = "這個 QR 已停用";
const RETIRED_HINT = "請跟管理公司拿最新的邀請";

test("TEN-29-AC3: retired /signup/unit-qr serves a static disabled notice and no signup surface", async ({ page }) => {
  const paths = ["/signup/unit-qr", "/signup/unit-qr?t=abc", "/signup/unit-qr?t=" + TOKEN];
  for (const path of paths) {
    await page.goto(path);
    expect(new URL(page.url()).pathname).toBe("/signup/unit-qr");
    await expect(page.getByText(RETIRED_HEADLINE)).toBeVisible();
    await expect(page.getByText(RETIRED_HINT)).toBeVisible();
    await expect(page.getByTestId("unit-qr-signup-hint")).toHaveCount(0);
    await expect(page.getByTestId("signup-email")).toHaveCount(0);
    await expect(page.getByTestId("signup-submit")).toHaveCount(0);
  }

  const responses = await Promise.all(paths.map(path => page.request.get(path, { maxRedirects: 0 })));
  for (const res of responses) {
    expect(res.status()).toBe(200);
    const headers = res.headers();
    expect(headers["location"]).toBeUndefined();
    expect(headers["cache-control"]).toContain("no-store");
    expect(headers["referrer-policy"]).toContain("no-referrer");
  }
  const bodies = await Promise.all(responses.map(res => res.body()));
  expect(bodies[1].equals(bodies[0])).toBe(true);
  expect(bodies[2].equals(bodies[0])).toBe(true);

  const post = await page.request.post("/api/signup/unit-qr", { data: { token: "x".repeat(43) }, maxRedirects: 0 });
  expect(post.status()).toBe(404);
  expect(post.headers()["set-cookie"]).toBeUndefined();
});

test("TEN-29-AC4: a stale condola_unit_qr cookie leaves ordinary /signup untouched", async ({ page, context, baseURL }) => {
  await page.goto("/signup");
  await expect(page.getByTestId("signup-email")).toBeVisible();
  await expect(page.getByTestId("signup-submit")).toBeVisible();
  await expect(page.getByTestId("unit-qr-signup-hint")).toHaveCount(0);
  const ordinary = await page.locator(".auth-wrap").evaluate(element => element.outerHTML);

  await context.addCookies([{ name: "condola_unit_qr", value: TOKEN, domain: new URL(baseURL!).hostname, path: "/signup", httpOnly: true }]);
  await page.goto("/signup");
  await expect(page.getByTestId("signup-email")).toBeVisible();
  await expect(page.getByTestId("signup-submit")).toBeVisible();
  await expect(page.getByTestId("unit-qr-signup-hint")).toHaveCount(0);
  expect(await page.locator(".auth-wrap").evaluate(element => element.outerHTML)).toBe(ordinary);
});

test("MGT-51-AC3: the retired /m/units/qr control is gone for anonymous callers", async ({ page }) => {
  const res = await page.request.get("/m/units/qr", { maxRedirects: 0 });
  const status = res.status();
  expect(status === 404 || (status >= 300 && status < 400)).toBe(true);
  if (status !== 404) expect(res.headers()["location"]).toBeTruthy();
  const body = (await res.body()).toString();
  expect(body).not.toContain("UnitQrControl");
  expect(body).not.toContain("單元申請連結");
  expect(body).not.toContain("Unit application link");
  expect(body).not.toContain("產生申請連結");
  expect(body).not.toContain("Generate application link");
});
