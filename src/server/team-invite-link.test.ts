import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

function source(path: string) {
  return readFileSync(new URL(path, import.meta.url), "utf8");
}

function exportedFunction(text: string, name: string) {
  const start = text.indexOf(`export async function ${name}(`);
  assert.ok(start >= 0, `Missing ${name}`);
  const end = text.indexOf("\nexport ", start + 1);
  return text.slice(start, end < 0 ? undefined : end);
}

const actions = source("./auth-actions.ts");

test("issue-link action rejects every non-admin session before issuing or reading origin", async () => {
  // Execute the actual guard/action body with isolated dependencies. This action
  // has no TypeScript body syntax other than literal const assertions.
  const declaration = exportedFunction(actions, "actionIssueTeamInviteLink");
  const opening = declaration.indexOf(") {");
  assert.ok(opening >= 0);
  const body = declaration.slice(opening + 3, declaration.lastIndexOf("}"))
    .replace(/ as const\b/g, "");
  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
  const cases = [
    null,
    ...["manager", "accountant", "maintenance"].map((role) => ({ kind: "staff", role })),
    { kind: "tenant", role: "admin" },
    { kind: "owner", role: "admin" },
  ];
  for (const session of cases) {
    const unexpected = () => assert.fail("Non-admin reached an issuance dependency");
    let consentChecks = 0;
    const run = new AsyncFunction(
      "input", "readSession", "teamInvitesAllowedForOrg", "resendInvite",
      "portalInviteOrigin", "requestOrigin", "teamLinkFailure", "requireCurrentConsent", body,
    );
    const result = await run(
      { invitationId: "test" }, async () => {
        assert.equal(consentChecks, 1);
        return session;
      }, unexpected, unexpected,
      unexpected, unexpected, unexpected, async () => {
        consentChecks++;
        return null;
      },
    );
    assert.equal(consentChecks, 1);
    assert.deepEqual(result, { ok: false, error: "errors.forbidden" });
  }
});

test("live link controls require staff admin, live environment and org allowlist", () => {
  const page = source("../app/m/team/page.tsx");
  assert.match(page, /const invitesOpen = session\.kind === "staff" && session\.role === "admin" &&\s*session\.environment === "live" && teamInvitesAllowedForOrg\(session\.orgId\)/);
  assert.match(page, /const legacyInvitesOpen = session\.environment !== "live" && teamInvitesAllowedForOrg\(session\.orgId\)/);
  assert.equal([...page.matchAll(/<TeamInviteLinkButton\b/g)].length, 1);
  assert.equal([...page.matchAll(/<TeamInviteForm\b/g)].length, 1);
  assert.match(page, /\{invitesOpen \? \(\s*member\.expires_at && new Date\(member\.expires_at\)\.getTime\(\) > Date\.now\(\) \? \(\s*<TeamInviteLinkButton invitationId=\{member\.invitation_id\} \/>\s*\) : null\s*\) : legacyInvitesOpen \? \(/);
  assert.match(page, /\) : invitesOpen \? \(\s*<TeamInviteForm \/>\s*\) : \(/);

  // Match the complete legacy resend and disabled fallback branches. Live
  // non-allowlisted sessions reach only the inert button, with no issuing form.
  assert.match(page, /\) : legacyInvitesOpen \? \(\s*<form action=\{actionResendInvite\}>\s*<input type="hidden" name="invitationId" value=\{member\.invitation_id\} \/>\s*<button className="btn sm" type="submit" data-testid=\{`resend-\$\{member\.email\}`\}>\s*\{t\("i_resend"\)\}\s*<\/button>\s*<\/form>\s*\) : \(\s*<button className="btn sm" type="button" disabled aria-disabled="true" data-testid=\{`resend-\$\{member\.email\}`\}>\s*\{t\("i_resend"\)\}\s*<\/button>\s*\)\}/);
  assert.match(page, /\{!invitesOpen && !legacyInvitesOpen \? \(\s*<div className="card pad" data-testid="team-invite-card">\s*<button className="btn" type="button" disabled aria-disabled="true" data-testid="team-invite-soon">\s*\{t\("i_team_invites_soon"\)\}\s*<\/button>\s*<\/div>/);
  assert.match(page, /params\.token && demoModeEnabled\(\)/);
  assert.match(page, /path: `\/join#t=\$\{params\.token\}`/);
});

test("team issuance links carry the token only in the join fragment", () => {
  for (const name of ["actionIssueTeamInviteLink", "actionCreateTeamInviteLink"]) {
    const body = exportedFunction(actions, name);
    assert.match(body, /url: `\$\{portalInviteOrigin\(await requestOrigin\(\)\)\}\/join#t=\$\{issued\.token\}`/);
    assert.doesNotMatch(body, /\/accept\/|\/join\?|encodeURIComponent\(issued\.token\)/);
  }
});

test("all invitation surfaces send no-referrer", () => {
  const config = source("../../next.config.ts");
  assert.match(config, /const INVITE_HEADERS = \[\.\.\.NO_STORE, \{ key: "Referrer-Policy", value: "no-referrer" \}\]/);
  for (const route of ["/join", "/accept/:path*", "/m/team"]) {
    assert.ok(config.includes(`{ source: "${route}", headers: INVITE_HEADERS }`), route);
  }
});

test("team issuance, rotation and acceptance neither mail nor audit secrets", () => {
  const auth = source("./auth.ts");
  for (const name of ["inviteMember", "resendInvite", "acceptTeamInvite"]) {
    const body = exportedFunction(auth, name);
    assert.doesNotMatch(body, /\bsendMail\s*\(/, name);
    const audits = [...body.matchAll(/\bwriteAudit\s*\([\s\S]*?\);/g)];
    assert.ok(audits.length > 0, `${name} must retain its audit`);
    for (const [call] of audits) {
      assert.doesNotMatch(call, /\b(?:token|url|code_hash)\b/i, `${name} audit`);
    }
  }
});

test("new team copy exists in both catalogs and excludes payment wording", () => {
  const keys = [
    "i_team_join_title", "i_team_invite_copy", "i_team_invite_reveal",
    "i_team_invite_rotates", "i_team_invite_copied", "i_team_invite_unavailable",
    "i_team_invite_account", "i_team_invite_copy_failed",
  ];
  for (const locale of ["zh-TW", "en"]) {
    const catalog = JSON.parse(source(`../i18n/${locale}.json`)) as Record<string, string>;
    for (const key of keys) {
      assert.equal(typeof catalog[key], "string", `${locale}: ${key}`);
      assert.ok(catalog[key].trim(), `${locale}: ${key}`);
      assert.doesNotMatch(catalog[key], /收款|收租|已收|入帳|代收|代付|金流/);
    }
  }
});

test("join captures and immediately removes the fragment without persisting or navigating with the token", () => {
  const join = source("../components/team-join.tsx");
  assert.match(join, /new URLSearchParams\(window\.location\.hash\.slice\(1\)\)/);
  const capture = join.indexOf('fragment.get("t")');
  const replace = join.indexOf('window.history.replaceState(window.history.state, "", window.location.pathname)');
  const retain = join.indexOf("setToken(captured)");
  assert.ok(capture >= 0 && replace > capture && retain > replace);
  assert.match(join, /const captured = fragment\.get\("t"\) \?\? "";\s*window\.history\.replaceState\(window\.history\.state, "", window\.location\.pathname\);\s*setToken\(captured\);/);
  assert.match(join, /if \(!captured\) return;\s*void actionDescribeTeamJoin\(captured\)/);
  assert.match(join, /actionAcceptTeamJoin\(\{\s*token,/);
  assert.doesNotMatch(join, /\b(?:localStorage|sessionStorage)\b/);
  assert.doesNotMatch(join, /(?:href|src|action)\s*=\s*\{[^}]*token/i);
  assert.doesNotMatch(join, /(?:pushState|replaceState|assign|replace|URL|URLSearchParams)\s*\([^;\n]*(?:\btoken\b|\bcaptured\b)/);
  assert.doesNotMatch(join, /(?:searchParams|fragment)\.(?:set|append)\s*\(/);
  assert.doesNotMatch(join, /location\.(?:hash|search|href)\s*=/);
  assert.match(join, /window\.addEventListener\("pagehide", clear\)/);
  assert.match(join, /setToken\(""\)/);
});

test("link display masks by default and reveals only after an explicit click", () => {
  const button = source("../components/team-invite-link-button.tsx");
  assert.match(button, /const \[revealed, setRevealed\] = useState\(false\)/);
  assert.match(button, /setRevealed\(false\)/);
  assert.match(button, /value=\{revealed \? link\.url : "…\/join#••••"\}/);
  assert.match(button, /onClick=\{\(\) => setRevealed\(true\)\}/);
  assert.doesNotMatch(button, /\b(?:localStorage|sessionStorage)\b/);
});

test("legacy acceptance has no team form or demo LINE button", () => {
  const page = source("../app/accept/[token]/page.tsx");
  const start = page.indexOf('if (invite.kind === "team_member")');
  const end = page.indexOf("const session = await readSession()", start);
  assert.ok(start >= 0 && end > start);
  const refusal = page.slice(start, end);
  assert.match(refusal, /return \(/);
  assert.match(refusal, /i_team_invite_unavailable/);
  assert.doesNotMatch(refusal, /<form|<AcceptForm/);
  assert.doesNotMatch(page, /accept-name|accept-submit|<PasswordFields|line-login|showDemoLineCopy/);
});
