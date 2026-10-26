import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import test from "node:test";
import { portalPageTarget, sameId } from "@/lib/portal-page";
import {
  PORTAL_COPY_HOLD_MS,
  finishPortalCopy,
  portalFailureVisible,
  portalIssueFailureKey,
  portalSuccessHoldComplete,
  portalSuccessVisible,
  startPortalCopy,
} from "@/lib/portal-copy";
import {
  inviteStoredEmail,
  inviteTokenBytes,
  mintedLoginEmail,
  newInviteToken,
  portalInviteDisplayEmail,
  portalInviteOrigin,
  portalInviteUrl,
  portalShownEmail,
} from "./portal-invite";
import { resolvePortalKind } from "./portal-role";

const zh = JSON.parse(readFileSync(new URL("../i18n/zh-TW.json", import.meta.url), "utf8")) as Record<string, string>;

test("invite links use an allowed request host, and production stays on app.condola.app", () => {
  const previous = process.env.CONDOLA_SITE_URL;
  const previousEnv = process.env.CONDOLA_ENV;
  try {
    process.env.CONDOLA_SITE_URL = "https://staging.condola.app";
    delete process.env.CONDOLA_ENV;
    const preview = "https://pr-31-condola-staging.condola.workers.dev";
    assert.equal(portalInviteOrigin(preview), preview);
    assert.equal(portalInviteOrigin(`${preview}/m/owners/abc`), preview);
    assert.equal(portalInviteOrigin("https://pr-31-fix-condola-staging.condola.workers.dev/m"), "https://pr-31-fix-condola-staging.condola.workers.dev");
    assert.equal(portalInviteOrigin("https://condola-staging.condola.workers.dev"), "https://staging.condola.app");
    assert.equal(portalInviteOrigin("https://app.condola.app/m/leases"), "https://app.condola.app");
    assert.equal(portalInviteOrigin("https://staging.condola.app"), "https://staging.condola.app");
    assert.equal(portalInviteOrigin("http://127.0.0.1:43123"), "https://staging.condola.app");
    assert.equal(portalInviteOrigin("https://evil.example"), "https://staging.condola.app");
    assert.equal(portalInviteOrigin("https://pr-31-condola-staging.condola.workers.dev.evil.example"), "https://staging.condola.app");
    assert.equal(portalInviteOrigin(""), "https://staging.condola.app");
    const previewUrl = portalInviteUrl(preview, "abc");
    assert.equal(previewUrl, `${preview}/accept/abc`);
    const stagingUrl = portalInviteUrl("https://condola-staging.condola.workers.dev", "abc");
    assert.equal(stagingUrl, "https://staging.condola.app/accept/abc");
    assert.equal(stagingUrl.includes("workers.dev"), false);
    process.env.CONDOLA_SITE_URL = "https://app.condola.app";
    const productionUrl = portalInviteUrl(preview, "abc");
    assert.equal(productionUrl, "https://app.condola.app/accept/abc");
    assert.equal(portalInviteOrigin("https://staging.condola.app"), "https://app.condola.app");
    assert.equal(portalInviteOrigin("https://preview.example.workers.dev"), "https://app.condola.app");
    delete process.env.CONDOLA_SITE_URL;
    process.env.CONDOLA_ENV = "production";
    assert.equal(portalInviteOrigin(preview), "https://app.condola.app");
    assert.equal(portalInviteOrigin("https://staging.condola.app"), "https://app.condola.app");
    assert.equal(portalInviteUrl("https://condola-staging.condola.workers.dev", "abc"), "https://app.condola.app/accept/abc");
    process.env.CONDOLA_ENV = "staging";
    assert.equal(portalInviteOrigin("https://app.condola.app"), "https://app.condola.app");
    assert.equal(portalInviteOrigin(preview), preview);
    assert.equal(portalInviteOrigin("https://evil.example"), "https://staging.condola.app");
    delete process.env.CONDOLA_ENV;
    assert.equal(portalInviteOrigin("http://127.0.0.1:43123"), "http://127.0.0.1:43123");
    assert.equal(portalInviteOrigin("http://localhost:3000/m"), "http://localhost:3000");
  } finally {
    if (previous === undefined) delete process.env.CONDOLA_SITE_URL;
    else process.env.CONDOLA_SITE_URL = previous;
    if (previousEnv === undefined) delete process.env.CONDOLA_ENV;
    else process.env.CONDOLA_ENV = previousEnv;
  }
});

test("a clipboard rejection is not a successful copy, and a failed request is a network error", async () => {
  const denied = new Error("Document is not focused");
  denied.name = "NotAllowedError";
  const clipboard = await finishPortalCopy("https://pr-31-condola-staging.condola.workers.dev/accept/abc", async () => {
    throw denied;
  });
  assert.deepEqual(clipboard, { ok: false, key: "i_portal_copy_failed" });
  const rejected = await finishPortalCopy("https://app.condola.app/accept/abc", async () => {
    throw new Error("writeText rejected");
  });
  assert.deepEqual(rejected, { ok: false, key: "i_portal_copy_failed" });
  let written = "";
  const copied = await finishPortalCopy("https://app.condola.app/accept/abc", async (value) => {
    written = value;
  });
  assert.deepEqual(copied, { ok: true });
  assert.equal(written, "https://app.condola.app/accept/abc");
  let blobText = "";
  class FakeItem {
    constructor(public parts: Record<string, Promise<Blob> | Blob>) {}
  }
  const granted = await startPortalCopy(
    Promise.resolve("https://app.condola.app/accept/abc"),
    {
      async write(items) {
        const item = items[0] as unknown as FakeItem;
        const blob = await item.parts["text/plain"];
        blobText = await blob.text();
      },
    },
    FakeItem as unknown as typeof ClipboardItem,
  );
  assert.deepEqual(granted, { ok: true });
  assert.equal(blobText, "https://app.condola.app/accept/abc");
  const deniedItem = await startPortalCopy(
    Promise.resolve("https://app.condola.app/accept/abc"),
    { write: async () => { throw new DOMException("Document is not focused", "NotAllowedError"); } },
    FakeItem as unknown as typeof ClipboardItem,
  );
  assert.deepEqual(deniedItem, { ok: false, key: "i_portal_copy_failed" });
  let fallback = "";
  const legacy = await startPortalCopy(Promise.resolve("https://staging.condola.app/accept/abc"), {
    async writeText(value) {
      fallback = value;
    },
  }, undefined);
  assert.deepEqual(legacy, { ok: true });
  assert.equal(fallback, "https://staging.condola.app/accept/abc");
  assert.equal(PORTAL_COPY_HOLD_MS >= 4000, true);
  assert.equal(portalSuccessVisible(3999, false), true);
  assert.equal(portalSuccessHoldComplete(3999), false);
  assert.equal(portalSuccessVisible(4000, false), true);
  assert.equal(portalSuccessHoldComplete(4000), true);
  assert.equal(portalSuccessVisible(4000, true), false);
  assert.equal(portalFailureVisible(10000, false), true);
  assert.equal(portalFailureVisible(10000, true), false);
  assert.equal(portalIssueFailureKey(new TypeError("Failed to fetch")), "i_portal_copy_offline");
  assert.equal(portalIssueFailureKey(new TypeError("Load failed")), "i_portal_copy_offline");
  assert.equal(portalIssueFailureKey(new Error("NetworkError when attempting to fetch resource.")), "i_portal_copy_offline");
  assert.equal(portalIssueFailureKey(new Error("errors.generic"), false), "i_portal_copy_offline");
  assert.equal(portalIssueFailureKey(denied), "i_portal_copy_failed");
  assert.equal(portalIssueFailureKey(new Error("errors.generic")), "i_portal_copy_failed");
});

test("portal tokens are at least 32 bytes and minted logins stay recognizable", () => {
  const token = newInviteToken();
  assert.ok(inviteTokenBytes(token) >= 32);
  assert.equal(token.includes("/"), false);
  assert.equal(mintedLoginEmail("portal-11111111-1111-4111-8111-111111111111@demo.condola.local"), true);
  assert.equal(mintedLoginEmail("owner1.demo@example.com"), false);
  assert.equal(mintedLoginEmail("someone@demo.condola.local"), false);
  assert.equal(mintedLoginEmail("tenant@example.com"), false);
  assert.equal(portalInviteDisplayEmail("portal-11111111-1111-4111-8111-111111111111@demo.condola.local"), "");
  assert.equal(portalInviteDisplayEmail("owner1.demo@example.com"), "owner1.demo@example.com");
  assert.equal(portalInviteDisplayEmail("tenant@example.com"), "tenant@example.com");
  assert.equal(inviteStoredEmail("owner1.demo@example.com"), "owner1.demo@example.com");
  assert.equal(inviteStoredEmail("portal-11111111-1111-4111-8111-111111111111@demo.condola.local"), null);
  assert.equal(inviteStoredEmail(null), null);
  assert.equal(
    portalShownEmail("portal-11111111-1111-4111-8111-111111111111@demo.condola.local", "owner1.demo@example.com"),
    "owner1.demo@example.com",
  );
  assert.equal(portalShownEmail("morgan.lee@owner.demo", "other@example.com"), "morgan.lee@owner.demo");
  assert.equal(portalShownEmail("portal-11111111-1111-4111-8111-111111111111@demo.condola.local", null), "");
});

test("portal invite copy hands the link over and stays on the locked wording", () => {
  const keys = [
    "i_portal_copy",
    "i_portal_copied",
    "i_portal_copied_for",
    "i_portal_regenerate",
    "i_portal_regenerate_confirm",
    "i_portal_renew",
    "i_portal_copy_failed",
    "i_portal_issuing",
    "i_portal_copy_manual",
    "i_portal_copy_offline",
    "i_portal_activated",
    "i_portal_hand_tenant",
    "i_portal_hand_owner",
    "i_portal_invite_title",
    "i_portal_invite_invalid",
    "i_portal_invite_locked",
    "i_portal_login_email",
    "i_portal_choose_email",
    "i_portal_email_unusable",
    "i_portal_password_wrong",
    "i_portal_timeout",
    "i_portal_bound",
    "i_portal_accept_failed",
    "i_portal_signed_in_other",
    "i_portal_sign_out_continue",
    "i_portal_link_mismatch",
    "i_portal_set_password",
    "i_portal_password_help",
    "i_portal_forgot",
    "i_portal_working",
    "i_switch_role_tenant",
    "i_switch_role_owner",
  ];
  assert.equal(zh.i_portal_copy, "複製邀請連結");
  assert.equal(zh.i_portal_copied, "已複製，7 天內有效，只能使用一次");
  assert.equal(zh.i_portal_copied_for, "已複製給 {name}（{email}）的邀請連結");
  assert.equal(zh.i_portal_regenerate, "重新產生連結");
  assert.equal(zh.i_portal_regenerate_confirm, "重新產生後，目前的邀請連結會失效。要繼續嗎？");
  assert.equal(zh.i_portal_renew, "這個連結無法再複製，請按重新產生連結。");
  assert.equal(zh.i_portal_copy_failed, "連結沒有複製成功，請按「複製」，或長按連結自己複製");
  assert.equal(zh.i_portal_issuing, "正在產生邀請連結…");
  assert.equal(zh.i_portal_copy_manual, "複製");
  assert.equal("i_portal_copy_hint" in zh, false);
  assert.equal(JSON.stringify(zh).includes("也可以長按連結自己複製"), false);
  assert.equal(zh.i_portal_copy_offline, "網路不穩，連結還沒產生，請再試一次");
  assert.equal(zh.i_portal_activated, "已啟用");
  assert.equal(zh.i_portal_hand_tenant, "傳給租客");
  assert.equal(zh.i_portal_hand_owner, "傳給屋主");
  assert.equal(zh.i_portal_invite_title, "{firm} 邀請你使用租多啦");
  assert.equal(zh.i_portal_invite_invalid, "這個連結已失效，請向管理公司索取新的連結");
  assert.equal(zh.i_portal_invite_locked, "嘗試次數過多，請 15 分鐘後再試");
  assert.equal(zh.i_portal_choose_email, "請填寫你的 Email。");
  assert.equal(zh.i_portal_email_unusable, "無法使用這個 email，請改用其他 email，或使用忘記密碼？");
  assert.equal(zh.i_portal_email_unusable.includes("聯絡管理公司"), false);
  assert.equal(zh.i_portal_password_wrong, "密碼不正確。請再試一次。");
  assert.equal(zh.i_portal_timeout, "處理時間過長，請再試一次。");
  assert.equal(zh.i_portal_sign_out_continue, "登出並繼續");
  assert.equal(zh.i_portal_signed_in_other, "您目前登入的是 {current}，這份邀請是給 {invite}。");
  assert.equal(zh.i_switch_role_tenant, "切換身分：租客");
  assert.equal(zh.i_switch_role_owner, "切換身分：屋主");
  assert.equal(zh.i_portal_set_password, "請設定或輸入密碼");
  assert.equal(zh.i_portal_password_help, "第一次使用請設定新密碼；已經有 Condola 帳號，請輸入原本的密碼。");
  assert.equal(zh.i_portal_password_help.includes("忘記密碼請聯絡管理公司"), false);
  assert.equal(zh.i_portal_forgot, "忘記密碼？");
  assert.equal(zh.i_portal_working, "處理中…");
  assert.equal(zh.i_portal_choose_email.includes("demo.condola.local"), false);
  assert.equal(zh.i_portal_choose_email.includes("portal-"), false);
  assert.equal(zh.i_portal_email_unusable.includes("已經用過"), false);
  for (const key of keys) {
    assert.equal(zh[key].includes("房東"), false, key);
    assert.equal(zh[key].includes("房客"), false, key);
    assert.equal(zh[key].includes("LINE"), false, key);
    assert.equal(zh[key].includes("即將推出"), false, key);
    assert.equal(zh[key].includes("寄"), false, key);
  }
  const page = readFileSync(new URL("../app/accept/[token]/page.tsx", import.meta.url), "utf8");
  const portalStart = page.indexOf('invite.kind === "owner"');
  const teamReturn = page.indexOf('invite.kind === "team_member"', portalStart);
  const portal = page.slice(portalStart, teamReturn < 0 ? undefined : teamReturn);
  assert.equal(portal.includes("PasswordFields"), false);
  assert.equal(portal.includes('name="confirm"'), false);
  assert.equal(portal.includes("portal-password-title"), true);
  assert.equal(portal.includes("i_portal_password_help"), true);
  assert.equal(portal.includes("portal-forgot"), true);
  assert.equal(portal.includes('href="/forgot"'), true);
  assert.equal(portal.includes("i_portal_forgot"), true);
  assert.equal(page.includes("<PasswordFields />"), false);
  assert.equal(page.includes('data-testid="accept-name"'), false);
  const teamJoin = readFileSync(new URL("../components/team-join.tsx", import.meta.url), "utf8");
  assert.equal(teamJoin.includes("<PasswordFields />"), true);
  assert.equal(teamJoin.includes('data-testid="accept-name"'), true);
  assert.equal(page.includes("portal-sign-out-continue"), true);
  assert.equal(page.includes("i_portal_signed_in_other"), true);
  assert.equal(page.includes('autoComplete="off"'), true);
  assert.equal(page.includes('autoComplete="username"'), false);
  const button = readFileSync(new URL("../components/portal-invite-button.tsx", import.meta.url), "utf8");
  assert.equal(button.includes("if (!regenerate && url)"), false);
  assert.equal(button.includes("if (!e&&u)"), false);
  assert.equal(button.includes("actionIssuePortalInvite({ kind, contactId, leaseId })"), false);
  assert.match(button, /window\.location\.pathname/);
  assert.match(button, /portalPageTarget/);
  assert.match(button, /window\.confirm/);
  assert.match(button, /result\.name/);
  assert.match(button, /result\.email/);
  assert.match(button, /sameId\(result\.contactId, contact\)/);
  assert.match(button, /startPortalCopy/);
  assert.match(button, /ClipboardItem/);
  assert.match(button, /writeText/);
  assert.match(button, /portalIssueFailureKey/);
  assert.match(button, /i_portal_issuing/);
  assert.match(button, /i_portal_copy_manual/);
  assert.equal(button.includes("i_portal_copy_hint"), false);
  assert.equal(button.includes("portal-invite-copy-hint"), false);
  assert.match(button, /readOnly/);
  assert.match(button, /PORTAL_COPY_HOLD_MS/);
  assert.match(button, /portal-invite-error-dismiss/);
  assert.match(button, /portal-invite-manual-copy/);
  assert.equal(button.includes("也可以長按連結自己複製"), false);
  assert.ok(button.indexOf("const copyPromise = startPortalCopy") < button.indexOf("await actionIssuePortalInvite"));
  assert.equal(button.includes("catch {\n        // The link stays"), false);
  const owners = readFileSync(new URL("../app/m/owners/[id]/page.tsx", import.meta.url), "utf8");
  const leases = readFileSync(new URL("../app/m/leases/[id]/page.tsx", import.meta.url), "utf8");
  assert.match(owners, /PortalInviteButton/);
  assert.match(leases, /PortalInviteButton/);
  assert.equal(owners.includes("writeText"), false);
  assert.equal(leases.includes("writeText"), false);
  const helper = readFileSync(new URL("../lib/portal-copy.ts", import.meta.url), "utf8");
  assert.match(helper, /finishPortalCopy/);
  assert.match(helper, /startPortalCopy/);
  assert.match(helper, /new ClipboardItem|new itemCtor/);
  assert.match(helper, /text\/plain/);
  assert.match(helper, /writeText/);
  assert.match(helper, /PORTAL_COPY_HOLD_MS = 4000/);
  assert.match(helper, /isPortalNetworkError/);
  const issuer = readFileSync(new URL("./portal-invite.ts", import.meta.url), "utf8");
  assert.match(owners, /data-owner-page=\{owner\.id\}/);
  assert.match(owners, /key=\{owner\.id\}/);
  assert.match(leases, /data-lease-page=\{id\}/);
  assert.match(issuer, /SET LOCAL lock_timeout = '8s'/);
  assert.match(issuer, /SET LOCAL statement_timeout = '8s'/);
  assert.match(issuer, /SET LOCAL ROLE service_role/);
  assert.match(issuer, /purge_portal_invite_secrets/);
  assert.match(issuer, /DELETE FROM portal_invite_secrets/);
  assert.match(issuer, /WHERE org_id = \$1 AND contact_id = \$2 AND status = 'pending'/);
  assert.equal(issuer.includes("pg_advisory_lock("), false);
  const migration = readFileSync(
    new URL("../../supabase/migrations/20261026190000_portal_invite_token.sql", import.meta.url),
    "utf8",
  );
  assert.equal(existsSync(new URL("../../supabase/migrations/20261025160000_portal_invite_token.sql", import.meta.url)), false);
  assert.equal(migration.includes("CREATE POLICY"), false);
  assert.match(migration, /ENABLE ROW LEVEL SECURITY/);
  assert.match(migration, /FORCE ROW LEVEL SECURITY/);
  assert.match(migration, /REVOKE ALL ON TABLE portal_invite_secrets FROM anon/);
  assert.match(migration, /REVOKE ALL ON TABLE portal_invite_secrets FROM authenticated/);
  assert.match(migration, /GRANT SELECT, INSERT, DELETE ON TABLE portal_invite_secrets TO service_role/);
  assert.match(migration, /DELETE FROM portal_invite_secrets/);
  assert.equal(migration.includes("TO anon"), false);
  assert.equal(migration.includes("TO authenticated"), false);
  assert.equal(migration.includes("is superuser"), false);
  const issueStart = issuer.indexOf("export async function issuePortalInvite");
  const issueBody = issuer.slice(issueStart);
  assert.equal(issueBody.includes("purgePortalInviteSecrets"), false);
  assert.match(issueBody, /lock_timeout = '1s'/);
  assert.match(issueBody, /statement_timeout = '2s'/);
  assert.equal(issuer.includes('if (!token) throw new FlowError("errors.portalRenew")'), false);
  assert.match(owners, /invitePending/);
  assert.match(owners, /ready && !owner\.invitePending/);
  for (const file of ["../components/page-error.tsx", "../app/m/error.tsx"]) {
    const boundary = readFileSync(new URL(file, import.meta.url), "utf8");
    assert.match(boundary, /頁面暫時無法載入/);
    assert.match(boundary, /可能是網路不穩，資料都還在。請再試一次。/);
    assert.match(boundary, /重新載入/);
    assert.match(boundary, /回到首頁/);
    assert.equal(boundary.includes("error.message"), false);
    assert.equal(boundary.includes("error.digest"), false);
    assert.equal(boundary.includes("系統錯誤"), false);
    assert.equal(boundary.includes("Application error"), false);
  }
  const globalError = readFileSync(new URL("../app/global-error.tsx", import.meta.url), "utf8");
  assert.match(globalError, /頁面暫時無法載入/);
  assert.match(globalError, /<PageError/);
  assert.equal(globalError.includes("error.message"), false);
  assert.equal(globalError.includes("error.digest"), false);
  assert.equal(globalError.includes("系統錯誤"), false);
  assert.equal(globalError.includes("Application error"), false);
  const auth = readFileSync(new URL("./auth.ts", import.meta.url), "utf8");
  assert.match(auth, /purgePortalInviteSecrets/);
  assert.match(auth, /deletePortalInviteSecret/);
  const ownerId = "10000000-0000-4000-8000-0000000000aa";
  assert.deepEqual(portalPageTarget(`/m/owners/${ownerId}`), { kind: "owner", pageId: ownerId });
  assert.deepEqual(portalPageTarget(`/m/owners/${ownerId}?x=1`), { kind: "owner", pageId: ownerId });
  assert.deepEqual(portalPageTarget(`/m/leases/${ownerId}`), { kind: "tenant", pageId: ownerId });
  assert.equal(portalPageTarget("/m/owners"), null);
  assert.equal(sameId(ownerId, ownerId.toUpperCase()), true);
  assert.equal(sameId(ownerId, "other"), false);
  const version = readFileSync(new URL("../app/api/version/route.ts", import.meta.url), "utf8");
  assert.match(version, /NEXT_PUBLIC_COMMIT/);
  const layout = readFileSync(new URL("../app/layout.tsx", import.meta.url), "utf8");
  assert.match(layout, /data-testid="app-version"/);
  assert.match(layout, /data-testid="switch-role"/);
});

test("a person who is both tenant and owner follows the page, then the latest invite", () => {
  assert.equal(
    resolvePortalKind({ path: "/o/statements", cookie: "tenant", isOwner: true, isTenant: true, latest: "tenant" }),
    "owner",
  );
  assert.equal(
    resolvePortalKind({ path: "/t/pay", cookie: "owner", isOwner: true, isTenant: true, latest: "owner" }),
    "tenant",
  );
  assert.equal(
    resolvePortalKind({ path: "/auth/continue", cookie: null, isOwner: true, isTenant: true, latest: "owner" }),
    "owner",
  );
  assert.equal(
    resolvePortalKind({ path: "/auth/continue", cookie: null, isOwner: true, isTenant: true, latest: "tenant" }),
    "tenant",
  );
  assert.equal(
    resolvePortalKind({ path: "/m", cookie: "tenant", isOwner: true, isTenant: false, latest: "owner" }),
    "owner",
  );
  assert.equal(resolvePortalKind({ path: "/o", cookie: null, isOwner: false, isTenant: true, latest: null }), "tenant");
});
