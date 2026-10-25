import { expect, test } from "@playwright/test";
import { Client } from "pg";
import { resetDemo } from "./session";

const DATABASE_URL = process.env.DATABASE_URL || "postgres://condola:condola@127.0.0.1:5432/condola";

async function teamInviteCount(email: string) {
  const client = new Client({ connectionString: DATABASE_URL });
  await client.connect();
  try {
    const all = await client.query<{ n: string }>(`SELECT count(*)::text AS n FROM invitations WHERE kind = 'team_member'`);
    const targeted = await client.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM invitations WHERE kind = 'team_member' AND lower(email::text) = lower($1)`,
      [email],
    );
    return { all: Number(all.rows[0].n), targeted: Number(targeted.rows[0].n) };
  } finally {
    await client.end();
  }
}

test("team member invites show 即將開放 and create no invitation", async ({ page }) => {
  const email = `blocked-${Date.now()}@example.com`;
  await resetDemo(page);
  const before = await teamInviteCount(email);

  await page.goto("/api/demo/locale?set=zh-TW&next=/m/team");
  const button = page.getByTestId("team-invite-soon");
  await expect(button).toBeVisible();
  await expect(button).toBeDisabled();
  await expect(button).toHaveText("即將開放");
  await expect(page.getByTestId("invite-email")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "送出邀請" })).toHaveCount(0);

  const response = await page.request.post("/api/flows/inviteTeammate", {
    data: { email, role: "manager", name: "新人" },
  });
  expect(response.status()).toBe(400);
  expect(await response.json()).toEqual({ ok: false, error: "errors.teamInvitesSoon" });

  await page.goto("/api/demo/locale?set=en&next=/m/team");
  await expect(page.getByTestId("team-invite-soon")).toHaveText("Coming soon");

  const after = await teamInviteCount(email);
  expect(after).toEqual(before);
  expect(after.targeted).toBe(0);
});
