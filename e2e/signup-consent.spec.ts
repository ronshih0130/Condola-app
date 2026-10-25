import { createHash, randomBytes } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { Client } from "pg";
import { expect, test } from "@playwright/test";
import { PRIVACY_VERSION, TERMS_VERSION } from "../src/server/legal-versions";

const DATABASE_URL = process.env.DATABASE_URL || "postgres://condola:condola@127.0.0.1:5432/condola";
const EVIDENCE = "e2e-evidence/signup-consent";
const CONSENT = "我已閱讀並同意《服務條款》與《隱私權政策》";

test("signup requires consent, then signUp stores the legal versions", async ({ page }) => {
  const email = `consent.${Date.now().toString(36)}@example.com`;
  const password = "Fresh1234";
  await page.goto("/signup");
  await expect(page.getByTestId("signup-consent-label")).toHaveText(CONSENT);
  await expect(page.getByTestId("signup-terms")).toHaveAttribute("href", "/terms");
  await expect(page.getByTestId("signup-terms")).toHaveAttribute("target", "_blank");
  await expect(page.getByTestId("signup-privacy")).toHaveAttribute("href", "/privacy");
  await expect(page.getByTestId("signup-privacy")).toHaveAttribute("target", "_blank");
  await expect(page.locator("body")).not.toContainText("事務所");

  await page.getByTestId("signup-email").fill(email);
  await page.getByTestId("signup-password").fill(password);
  await page.getByTestId("signup-confirm").fill(password);
  const submit = page.getByTestId("signup-submit");
  await expect(submit).toBeDisabled();
  mkdirSync(EVIDENCE, { recursive: true });
  await page.screenshot({ path: `${EVIDENCE}/step1-unchecked.png`, fullPage: true });
  await submit.click({ force: true });
  await expect(page).toHaveURL(/\/signup\/?(\?.*)?$/);
  await expect(page.getByTestId("verify-body")).toHaveCount(0);

  await page.getByTestId("signup-consent").check();
  await expect(submit).toBeEnabled();
  await page.screenshot({ path: `${EVIDENCE}/step1-checked.png`, fullPage: true });
  await submit.click();
  await page.waitForURL(/\/signup\/verify/);
  await expect(page.getByTestId("verify-body")).toContainText(email);

  const captured = await page.request.get("http://127.0.0.1:4599/e2e/signups");
  expect(captured.ok()).toBeTruthy();
  const bodies = (await captured.json()) as {
    email?: string;
    password?: string;
    data?: { terms_accepted_at?: string; terms_version?: string; privacy_version?: string };
    options?: { data?: { terms_accepted_at?: string; terms_version?: string; privacy_version?: string } };
  }[];
  const match = bodies.find((body) => body.email === email);
  expect(match?.data?.terms_version).toBe(TERMS_VERSION);
  expect(match?.data?.privacy_version).toBe(PRIVACY_VERSION);
  expect(match?.data?.terms_accepted_at ?? "").toMatch(/^\d{4}-\d{2}-\d{2}T/);
  expect(match?.options?.data).toEqual(match?.data);
  const evidence = {
    email,
    data: match?.data,
    options: { data: match?.options?.data },
  };
  writeFileSync(`${EVIDENCE}/signup-payload.json`, `${JSON.stringify(evidence, null, 2)}\n`);
  expect(JSON.stringify(evidence)).not.toContain(password);

  const client = new Client({ connectionString: DATABASE_URL });
  await client.connect();
  try {
    const user = await client.query<{ id: string }>(`SELECT id::text AS id FROM auth.users WHERE lower(email) = lower($1)`, [email]);
    const userId = user.rows[0]?.id;
    expect(userId).toBeTruthy();
    await client.query(`UPDATE auth.users SET email_confirmed_at = now() WHERE id = $1`, [userId]);
    const token = randomBytes(32).toString("base64url");
    const hash = createHash("sha256").update(token).digest("hex");
    await client.query(
      `INSERT INTO auth_sessions (user_id, token_hash, expires_at) VALUES ($1, $2, now() + interval '1 day')`,
      [userId, hash],
    );
    await page.context().addCookies([
      {
        name: "condola_session",
        value: token,
        url: "http://127.0.0.1:43123",
        httpOnly: true,
        sameSite: "Lax",
      },
    ]);
  } finally {
    await client.end();
  }

  await page.goto("/signup/firm");
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("你的身分");
  await page.getByTestId("kind-self").check();
  await page.getByTestId("kind-next").click();
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("建立你的公司");
  await expect(page.locator("[data-testid='signup-details'] label.f").first()).toHaveText("公司名稱");
  await expect(page.getByTestId("firm-name-hint")).toHaveText("個人屋主可填自己的名字");
  await expect(page.getByTestId("firm-name")).not.toHaveAttribute("placeholder");
  await expect(page.getByTestId("signup-admin-note")).toHaveText("註冊者會成為這個帳號的管理員");
  await expect(page.getByTestId("firm-submit")).toHaveText("建立公司");
  await expect(page.getByTestId("firm-form")).not.toContainText("事務所");
  await expect(page.getByTestId("firm-submit")).toBeEnabled();
  await page.screenshot({ path: `${EVIDENCE}/step4.png`, fullPage: true });
});
