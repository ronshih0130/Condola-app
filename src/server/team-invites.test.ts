import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { makeT } from "@/i18n";
import { errorText } from "@/i18n/errors";
import { POST } from "@/app/api/flows/[action]/route";
import { actionInvite as legacyActionInvite } from "./actions";
import { actionInvite } from "./auth-actions";
import { TEAM_INVITES_ENABLED } from "./team-invites";

function redirectTarget(error: unknown) {
  const digest = typeof error === "object" && error && "digest" in error ? String((error as { digest?: string }).digest) : "";
  assert.match(digest, /^NEXT_REDIRECT;/);
  return digest.split(";").slice(2, -2).join(";");
}

test("team invite actions and the API refuse while invites are off", async () => {
  assert.equal(TEAM_INVITES_ENABLED, false);
  assert.equal(errorText(makeT("zh-TW"), "errors.teamInvitesSoon"), "即將開放");
  assert.equal(errorText(makeT("en"), "errors.teamInvitesSoon"), "Coming soon");

  const form = new FormData();
  form.set("email", "blocked.hire@example.com");
  form.set("name", "新人");
  form.set("role", "manager");
  const calls: string[] = [];
  const saved = global.fetch;
  global.fetch = async (input) => {
    calls.push(String(input));
    throw new Error("team invite must not send mail");
  };
  try {
    for (const invite of [actionInvite, legacyActionInvite]) {
      await assert.rejects(() => invite(form), (error: unknown) => {
        assert.equal(redirectTarget(error), "/m/team?error=errors.teamInvitesSoon");
        return true;
      });
    }
    const response = await POST(
      new Request("http://127.0.0.1/api/flows/inviteTeammate", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email: "blocked.hire@example.com", role: "manager" }),
      }),
      { params: Promise.resolve({ action: "inviteTeammate" }) },
    );
    assert.equal(response.status, 400);
    assert.deepEqual(await response.json(), { ok: false, error: "errors.teamInvitesSoon" });
    assert.deepEqual(calls, []);
  } finally {
    global.fetch = saved;
  }

  const auth = readFileSync(new URL("./auth-actions.ts", import.meta.url), "utf8");
  const authInvite = auth.slice(auth.indexOf("export async function actionInvite"), auth.indexOf("export async function actionResendInvite"));
  assert.ok(authInvite.indexOf("assertTeamInvitesEnabled()") < authInvite.indexOf("inviteMember("));
  const legacy = readFileSync(new URL("./actions.ts", import.meta.url), "utf8");
  const legacyInvite = legacy.slice(legacy.indexOf("export async function actionInvite"), legacy.indexOf("export async function actionSetMeter"));
  assert.ok(legacyInvite.indexOf("assertTeamInvitesEnabled()") < legacyInvite.indexOf("inviteTeammate("));
  const route = readFileSync(new URL("../app/api/flows/[action]/route.ts", import.meta.url), "utf8");
  assert.match(route, /action === "inviteTeammate" && !TEAM_INVITES_ENABLED/);
  const guard = route.indexOf('action === "inviteTeammate" && !TEAM_INVITES_ENABLED');
  assert.ok(guard < route.indexOf("readSession()"));
  assert.ok(guard < route.indexOf("handler(session, body)"));
});
