import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { gotrueAccessTokenLifetime } from "./signup";

function read(file: string) {
  return readFileSync(file, "utf8");
}

function token(iat: number, exp: number) {
  const payload = Buffer.from(JSON.stringify({ iat, exp })).toString("base64url");
  return `header.${payload}.sig`;
}

test("confirm-token clears the hash before posting the access token", () => {
  const source = read("src/components/confirm-token.tsx");
  const clear = source.indexOf("window.history.replaceState");
  const post = source.indexOf("actionConfirmSupabase(access)");
  assert.ok(clear > 0);
  assert.ok(post > clear);
});

test("the confirm access token is not written to logs, funnel events, or analytics", () => {
  const files = [
    "src/components/confirm-token.tsx",
    "src/components/auth-hash.tsx",
    "src/server/signup-actions.ts",
    "src/server/signup.ts",
    "src/server/signup-gotrue.ts",
    "src/server/funnel.ts",
  ];
  const joined = files.map(read).join("\n");
  assert.doesNotMatch(joined, /sentry|posthog|gtag\(|plausible|breadcrumb/i);
  const action = read("src/server/signup-actions.ts");
  const start = action.indexOf("export async function actionConfirmSupabase");
  const body = action.slice(start, action.indexOf("export async function actionCreateFirm"));
  assert.match(body, /console\.error\("confirm access token failed"\)/);
  assert.doesNotMatch(body, /console\.(log|info|warn|error|debug)\(\s*error/);
  assert.doesNotMatch(body, /console\.(log|info|warn|error|debug)\([^)\n]*accessToken/);
  const confirmStart = read("src/server/signup.ts").indexOf("export async function confirmSupabaseAccessToken");
  const confirm = read("src/server/signup.ts").slice(
    confirmStart,
    read("src/server/signup.ts").indexOf("export async function confirmSupabaseTokenHash"),
  );
  assert.doesNotMatch(confirm, /console\./);
  assert.doesNotMatch(confirm, /recordFunnel\(/);
  assert.doesNotMatch(read("src/server/funnel.ts"), /access_token|accessToken/);
});

test("a confirm JWT longer than the GoTrue expiry is rejected", () => {
  const now = 1_700_000_000;
  assert.equal(gotrueAccessTokenLifetime(token(now, now + 3600), now + 10), "ok");
  assert.equal(gotrueAccessTokenLifetime(token(now, now + 3601), now + 10), "long");
  assert.equal(gotrueAccessTokenLifetime(token(now - 4000, now - 1), now), "expired");
  assert.equal(gotrueAccessTokenLifetime("not-a-jwt", now), "malformed");
  assert.equal(gotrueAccessTokenLifetime("header.%%%%.sig", now), "malformed");
  const config = read("supabase/config.toml");
  assert.match(config, /jwt_expiry = 3600/);
  assert.match(config, /otp_expiry = 3600/);
  assert.match(read("src/server/signup.ts"), /gotrue_confirm_uses/);
  assert.match(read("src/server/signup.ts"), /claimGotrueConfirmToken/);
  assert.match(read("src/server/signup.ts"), /DELETE FROM gotrue_confirm_uses/);
  assert.match(read("src/server/signup.ts"), /make_interval\(secs => \$1\)/);
  assert.match(read("src/server/signup.ts"), /GOTRUE_JWT_EXPIRY_SECONDS \* 2/);
});
