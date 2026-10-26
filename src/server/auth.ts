import { createHash, randomBytes } from "node:crypto";
import type { Client } from "pg";
import { writeAudit } from "./audit";
import { writeConsent } from "./consent";
import { teamInviteBlocked } from "./consent-gate";
import { query, withClient } from "./db";
import { recordFunnel } from "./funnel";
import { SERVICE_EMAIL, sendMail } from "./mail";
import { passwordResetMail } from "./mail-copy";
import { consumePasswordReset } from "./reset-limit";
import { classifyPasswordGrant, gotrueVerifyBody, parseGenerateLink, parseGotrueUserId, passwordResetUrl } from "./signup-gotrue";
import { lineLoginEnabled } from "./demo";
import { outboundNote } from "./outbound";
import { FlowError } from "./errors";
import { LOCKOUT_LIMIT, lockActive, nextFailure } from "./lockout";
import { passwordAcceptable } from "./password";
import { authEmailTaken } from "./portal-login";
import {
  deletePortalInviteSecret,
  hashInviteToken,
  inviteAttemptLocked,
  mintedLoginEmail,
  noteBadInvite,
  noteTokenInviteAttempt,
  portalShownEmail,
  purgePortalInviteSecrets,
  tokenInviteLocked,
  withInviteLock,
} from "./portal-invite";
import { assertSeatAvailable } from "./seats";
import { assertPerm } from "./perms";
import { appCookieOptions } from "./public-origin";
import { privacyFromSettings, type OwnerPrivacy } from "./privacy";
import { backupCodes, acceptSecondFactor, otpauthUrl, randomBase32 } from "./totp";
import type { OrgRole, Session } from "./types";

export const SESSION_COOKIE = "condola_session";
export const CHALLENGE_COOKIE = "condola_challenge";

const RESET_MINUTES = 60;
const INVITE_DAYS = 7;

export type RequestMeta = { ua: string | null; ip: string | null };

export type SignInResult =
  | { ok: true; token: string; remember: boolean; destination?: "firm" }
  | { ok: false; error: "invalid" | "locked" | "disabled" | "unconfirmed" | "unavailable" }
  | { ok: false; step: "2fa" | "enroll"; challengeId: string; secret?: string; otpauth?: string };

function sha256(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

function newToken() {
  return randomBytes(32).toString("base64url");
}

export function normalizeEmail(value: string) {
  const trimmed = value.trim().toLowerCase();
  const at = trimmed.indexOf("@");
  if (at <= 0 || at !== trimmed.lastIndexOf("@")) return null;
  // application/x-www-form-urlencoded turns "+" into a space. A local-part cannot contain spaces.
  const local = trimmed.slice(0, at).replaceAll(/\s+/g, "+");
  const domain = trimmed.slice(at + 1).trim();
  const email = `${local}@${domain}`;
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return null;
  return email;
}

function cookieBase() {
  return appCookieOptions();
}

export function sessionCookie(token: string, remember: boolean) {
  return {
    name: SESSION_COOKIE,
    value: token,
    options: remember ? { ...cookieBase(), maxAge: 60 * 60 * 24 * 30 } : cookieBase(),
  };
}

export function challengeCookie(id: string) {
  return { name: CHALLENGE_COOKIE, value: id, options: { ...cookieBase(), maxAge: 60 * 10 } };
}

function supabaseUrl() {
  return process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL || "";
}

async function localPasswordCheck(email: string, password: string): Promise<string | "unconfirmed" | null> {
  const result = await query<{ id: string; email_confirmed_at: Date | null }>(
    `SELECT id::text AS id, email_confirmed_at FROM auth.users
      WHERE lower(email) = lower($1)
        AND encrypted_password IS NOT NULL
        AND encrypted_password = crypt($2, encrypted_password)`,
    [email, password],
  );
  const row = result.rows[0];
  if (!row) return null;
  if (!row.email_confirmed_at) return "unconfirmed";
  return row.id;
}

export async function verifyPassword(email: string, password: string): Promise<string | "unconfirmed" | "unavailable" | null> {
  const url = supabaseUrl();
  const anon = process.env.SUPABASE_ANON_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || "";
  if (url && anon) {
    let remote: ReturnType<typeof classifyPasswordGrant> = "unavailable";
    try {
      const response = await fetch(`${url.replace(/\/$/, "")}/auth/v1/token?grant_type=password`, {
        method: "POST",
        headers: { apikey: anon, "Content-Type": "application/json" },
        body: JSON.stringify({ email, password }),
      });
      const body = await response.json().catch(() => ({}));
      remote = classifyPasswordGrant(response.status, body);
    } catch {
      remote = "unavailable";
    }
    if (typeof remote === "object") return remote.userId;
    const local = await localPasswordCheck(email, password);
    if (remote === "unconfirmed" || local === "unconfirmed") return "unconfirmed";
    if (remote === "unavailable" && typeof local === "string") return local;
    return null;
  }
  return localPasswordCheck(email, password);
}

export async function setUserPassword(userId: string, password: string, email?: string): Promise<"ok" | "emailTaken"> {
  const url = supabaseUrl();
  const service = process.env.SUPABASE_SERVICE_ROLE_KEY || "";
  const nextEmail = email?.trim() ? email.trim().toLowerCase() : "";
  if (url && service) {
    try {
      const payload: { password: string; email?: string; email_confirm?: boolean } = { password };
      if (nextEmail) {
        payload.email = nextEmail;
        payload.email_confirm = true;
      }
      const response = await fetch(`${url.replace(/\/$/, "")}/auth/v1/admin/users/${userId}`, {
        method: "PUT",
        headers: {
          apikey: service,
          Authorization: `Bearer ${service}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(payload),
      });
      if (response.ok) return "ok";
      if (nextEmail) {
        const body = await response.text();
        if (response.status === 422 || response.status === 409 || /already been registered|email_exists|duplicate key/i.test(body)) {
          return "emailTaken";
        }
      }
    } catch {
      // Sign-in reads auth.users. A missing admin API still has to set that row.
    }
  }
  try {
    if (nextEmail) {
      await query(
        `UPDATE auth.users
            SET email = $2,
                encrypted_password = crypt($3, gen_salt('bf')),
                email_confirmed_at = coalesce(email_confirmed_at, now()),
                updated_at = now()
          WHERE id = $1`,
        [userId, nextEmail, password],
      );
    } else {
      await query(
        `UPDATE auth.users SET encrypted_password = crypt($2, gen_salt('bf')), updated_at = now() WHERE id = $1`,
        [userId, password],
      );
    }
  } catch (error) {
    if (nextEmail && authEmailTaken(error)) return "emailTaken";
    throw error;
  }
  return "ok";
}

async function primaryOrg(userId: string) {
  const member = await query<{ org_id: string }>(
    `SELECT org_id::text FROM org_members WHERE user_id = $1 AND status = 'active' ORDER BY created_at LIMIT 1`,
    [userId],
  );
  if (member.rows[0]) return member.rows[0].org_id;
  const contact = await query<{ org_id: string }>(
    `SELECT org_id::text FROM contacts WHERE user_id = $1 AND archived_at IS NULL ORDER BY created_at LIMIT 1`,
    [userId],
  );
  return contact.rows[0]?.org_id ?? null;
}

async function failureState(email: string, now = new Date()) {
  const row = await query<{ failed_count: number; locked_until: Date | null }>(
    `SELECT failed_count, locked_until FROM auth_login_attempts WHERE email = $1`,
    [email],
  );
  const current = row.rows[0];
  if (current && lockActive(current.locked_until, now)) {
    return { locked: true as const, failedCount: current.failed_count };
  }
  const base = current && current.locked_until && !lockActive(current.locked_until, now) ? 0 : (current?.failed_count ?? 0);
  const next = nextFailure(base, now);
  await query(
    `INSERT INTO auth_login_attempts (email, failed_count, locked_until, updated_at)
     VALUES ($1, $2, $3, now())
     ON CONFLICT (email) DO UPDATE
       SET failed_count = EXCLUDED.failed_count, locked_until = EXCLUDED.locked_until, updated_at = now()`,
    [email, next.failedCount, next.lockedUntil],
  );
  return { locked: next.locked, failedCount: next.failedCount };
}

async function clearFailures(email: string) {
  await query(`DELETE FROM auth_login_attempts WHERE email = $1`, [email]);
}

async function accessState(userId: string) {
  const members = await query<{ status: string }>(
    `SELECT status::text FROM org_members WHERE user_id = $1`,
    [userId],
  );
  const activeMember = members.rows.some((row) => row.status === "active");
  const suspended = members.rows.some((row) => row.status === "suspended");
  if (activeMember) return "active" as const;
  if (suspended) return "disabled" as const;
  const portal = await query(
    `SELECT 1 FROM contacts WHERE user_id = $1 AND archived_at IS NULL AND (is_tenant OR is_owner) LIMIT 1`,
    [userId],
  );
  return portal.rows[0] ? ("portal" as const) : ("none" as const);
}

async function firmRequiresMfa(userId: string) {
  const row = await query<{ required: boolean }>(
    `SELECT coalesce(bool_or(coalesce(o.settings->>'require_2fa', 'false') = 'true'), false) AS required
       FROM org_members m JOIN organizations o ON o.id = m.org_id
      WHERE m.user_id = $1 AND m.status = 'active'`,
    [userId],
  );
  return Boolean(row.rows[0]?.required);
}

async function mfaRow(userId: string) {
  const row = await query<{ totp_secret: string | null; enabled: boolean; backup_code_hashes: string[] }>(
    `SELECT totp_secret, enabled, backup_code_hashes FROM user_mfa WHERE user_id = $1`,
    [userId],
  );
  return row.rows[0] ?? null;
}

export async function createSession(userId: string, remember: boolean, meta: RequestMeta) {
  const token = newToken();
  const hours = remember ? 24 * 30 : 12;
  await query(
    `INSERT INTO auth_sessions (user_id, token_hash, user_agent, ip, expires_at)
     VALUES ($1, $2, $3, $4, now() + make_interval(hours => $5))`,
    [userId, sha256(token), meta.ua?.slice(0, 300) ?? null, meta.ip, hours],
  );
  await writeAudit(await primaryOrg(userId), userId, "sign_in", { remember });
  return token;
}

async function openChallenge(userId: string, purpose: "2fa" | "enroll", remember: boolean, secret?: string) {
  const inserted = await query<{ id: string }>(
    `INSERT INTO auth_challenges (user_id, purpose, remember, totp_secret, expires_at)
     VALUES ($1, $2, $3, $4, now() + interval '10 minutes') RETURNING id::text`,
    [userId, purpose, remember, secret ?? null],
  );
  return inserted.rows[0].id;
}

export async function signIn(emailRaw: string, password: string, remember: boolean, meta: RequestMeta): Promise<SignInResult> {
  const email = normalizeEmail(emailRaw);
  if (!email || !password) {
    return { ok: false, error: "invalid" };
  }
  const existing = await query<{ failed_count: number; locked_until: Date | null }>(
    `SELECT failed_count, locked_until FROM auth_login_attempts WHERE email = $1`,
    [email],
  );
  if (existing.rows[0] && lockActive(existing.rows[0].locked_until, new Date())) {
    return { ok: false, error: "locked" };
  }
  const userId = await verifyPassword(email, password);
  if (userId === "unconfirmed") return { ok: false, error: "unconfirmed" };
  if (userId === "unavailable") return { ok: false, error: "unavailable" };
  if (!userId) {
    const failed = await failureState(email);
    return { ok: false, error: failed.locked || failed.failedCount >= LOCKOUT_LIMIT ? "locked" : "invalid" };
  }
  await clearFailures(email);
  return continueSignIn(userId, email, remember, meta);
}

async function continueSignIn(userId: string, email: string, remember: boolean, meta: RequestMeta): Promise<SignInResult> {
  const access = await accessState(userId);
  if (access === "disabled") return { ok: false, error: "disabled" };
  if (access === "none") {
    const row = await query<{ email: string; email_confirmed_at: Date | null }>(
      `SELECT email, email_confirmed_at FROM auth.users WHERE id = $1`,
      [userId],
    );
    const account = row.rows[0];
    if (!account?.email_confirmed_at) {
      await query(
        `UPDATE auth.users SET email_confirmed_at = now(), updated_at = now() WHERE id = $1 AND email_confirmed_at IS NULL`,
        [userId],
      );
      await recordFunnel("email_confirmed", { userId, email: account?.email || email });
    }
    const token = await createSession(userId, remember, meta);
    return { ok: true, token, remember, destination: "firm" };
  }
  const factor = await mfaRow(userId);
  if (factor?.enabled && factor.totp_secret) {
    const challengeId = await openChallenge(userId, "2fa", remember);
    return { ok: false, step: "2fa", challengeId };
  }
  if (await firmRequiresMfa(userId)) {
    const secret = randomBase32();
    const profile = await query<{ email: string }>(`SELECT email FROM auth.users WHERE id = $1`, [userId]);
    const challengeId = await openChallenge(userId, "enroll", remember, secret);
    return {
      ok: false,
      step: "enroll",
      challengeId,
      secret,
      otpauth: otpauthUrl(secret, profile.rows[0]?.email ?? email),
    };
  }
  const token = await createSession(userId, remember, meta);
  return { ok: true, token, remember };
}

/** Demo LINE Login: signs in the linked member. Does not call LINE. */
export async function signInWithLine(meta: RequestMeta): Promise<SignInResult> {
  if (!lineLoginEnabled()) return { ok: false, error: "invalid" };
  const linked = await query<{ id: string; email: string }>(
    `SELECT u.id::text AS id, u.email
       FROM profiles p
       JOIN auth.users u ON u.id = p.id
       JOIN org_members m ON m.user_id = p.id AND m.status = 'active'
      WHERE p.line_linked = true
      ORDER BY m.created_at
      LIMIT 1`,
  );
  const person = linked.rows[0];
  if (!person) return { ok: false, error: "invalid" };
  await writeAudit(await primaryOrg(person.id), person.id, "line_sign_in", {});
  return continueSignIn(person.id, person.email, true, meta);
}

export async function peekChallenge(id: string) {
  const row = await loadChallenge(id);
  if (!row) return null;
  if (row.purpose === "enroll" && row.totp_secret) {
    return { purpose: row.purpose, secret: row.totp_secret, otpauth: otpauthUrl(row.totp_secret, row.email) };
  }
  return { purpose: row.purpose, secret: null as string | null, otpauth: null as string | null };
}

async function loadChallenge(id: string) {
  const row = await query<{
    id: string;
    user_id: string;
    purpose: "2fa" | "enroll";
    remember: boolean;
    totp_secret: string | null;
    email: string;
  }>(
    `SELECT c.id::text, c.user_id::text, c.purpose, c.remember, c.totp_secret, u.email
       FROM auth_challenges c JOIN auth.users u ON u.id = c.user_id
      WHERE c.id = $1 AND c.expires_at > now()`,
    [id],
  );
  return row.rows[0] ?? null;
}

async function consumeBackup(userId: string, code: string) {
  const factor = await mfaRow(userId);
  if (!factor) return false;
  const hash = sha256(code.trim().toUpperCase());
  if (!factor.backup_code_hashes.includes(hash)) return false;
  await query(
    `UPDATE user_mfa SET backup_code_hashes = array_remove(backup_code_hashes, $2), updated_at = now() WHERE user_id = $1`,
    [userId, hash],
  );
  return true;
}

export async function completeSecondFactor(challengeId: string, code: string, meta: RequestMeta): Promise<SignInResult & { backupCodes?: string[] }> {
  const challenge = await loadChallenge(challengeId);
  if (!challenge) return { ok: false, error: "invalid" };
  if (challenge.purpose === "2fa") {
    const factor = await mfaRow(challenge.user_id);
    const totpOk = acceptSecondFactor(factor?.totp_secret, code);
    const backupOk = totpOk ? false : await consumeBackup(challenge.user_id, code);
    if (!totpOk && !backupOk) return { ok: false, error: "invalid" };
  } else {
    if (!acceptSecondFactor(challenge.totp_secret, code)) return { ok: false, error: "invalid" };
  }
  await query(`DELETE FROM auth_challenges WHERE id = $1`, [challenge.id]);
  let codes: string[] | undefined;
  if (challenge.purpose === "enroll" && challenge.totp_secret) {
    codes = backupCodes();
    await query(
      `INSERT INTO user_mfa (user_id, totp_secret, enabled, backup_code_hashes, confirmed_at)
       VALUES ($1, $2, true, $3, now())
       ON CONFLICT (user_id) DO UPDATE
         SET totp_secret = EXCLUDED.totp_secret, enabled = true, backup_code_hashes = EXCLUDED.backup_code_hashes,
             confirmed_at = now(), updated_at = now()`,
      [challenge.user_id, challenge.totp_secret, codes.map((item) => sha256(item))],
    );
    await writeAudit(await primaryOrg(challenge.user_id), challenge.user_id, "mfa_enabled", {});
  }
  const token = await createSession(challenge.user_id, challenge.remember, meta);
  return { ok: true, token, remember: challenge.remember, backupCodes: codes };
}

async function sandboxOnlyAccount(email: string) {
  if (!process.env.DATABASE_URL) return false;
  try {
    const row = await query<{ live: boolean | null; sandbox: boolean | null }>(
      `SELECT bool_or(o.environment = 'live') AS live,
              bool_or(o.environment = 'sandbox') AS sandbox
         FROM auth.users u
         LEFT JOIN org_members m ON m.user_id = u.id AND m.status = 'active'
         LEFT JOIN organizations o ON o.id = m.org_id
        WHERE lower(u.email::text) = lower($1)
        GROUP BY u.id`,
      [email],
    );
    const found = row.rows[0];
    return Boolean(found && found.sandbox === true && found.live !== true);
  } catch (error) {
    console.error("password reset org", error instanceof Error ? error.message : "failed");
    return false;
  }
}

async function logPasswordReset(email: string, userId: string, messageId: string) {
  const id = userId || (await query<{ id: string }>(`SELECT id::text AS id FROM auth.users WHERE lower(email::text) = lower($1)`, [email])).rows[0]?.id || "";
  if (!id) return;
  try {
    const org = await query<{ id: string }>(
      `SELECT m.org_id::text AS id
         FROM org_members m
         JOIN organizations o ON o.id = m.org_id
        WHERE m.user_id = $1 AND m.status = 'active' AND o.environment = 'live'
        ORDER BY m.created_at
        LIMIT 1`,
      [id],
    );
    await query(
      `INSERT INTO email_log (org_id, kind, target_id, threshold, message_id)
       VALUES ($1, 'password_reset', $2, 0, $3)`,
      [org.rows[0]?.id ?? null, id, messageId],
    );
  } catch (error) {
    console.error("email_log", error instanceof Error ? error.message : "failed");
  }
}

async function deliverResetLink(email: string, link: string, userId: string) {
  const rendered = passwordResetMail(link);
  const sent = await sendMail({
    to: email,
    subject: rendered.subject,
    text: rendered.text,
    html: rendered.html,
    replyTo: SERVICE_EMAIL,
  });
  if (sent.ok) await logPasswordReset(email, userId, sent.messageId);
}

/** POST the recovery token. GET must not call this. A local reset token is minted only after GoTrue accepts it. */
export async function verifyRecoveryTokenHash(tokenHash: string) {
  const url = supabaseUrl();
  const anon = process.env.SUPABASE_ANON_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || "";
  const hash = tokenHash.trim();
  if (!url || !anon || !hash) return { ok: false as const, error: "expired" as const };
  const response = await fetch(`${url.replace(/\/$/, "")}/auth/v1/verify`, {
    method: "POST",
    headers: { apikey: anon, "Content-Type": "application/json" },
    body: JSON.stringify(gotrueVerifyBody("recovery", hash)),
  });
  if (!response.ok) return { ok: false as const, error: "expired" as const };
  const user = parseGotrueUserId(await response.json().catch(() => ({})));
  if (!user) return { ok: false as const, error: "expired" as const };
  const token = newToken();
  await query(
    `INSERT INTO auth_password_resets (user_id, token_hash, expires_at) VALUES ($1, $2, now() + make_interval(mins => $3))`,
    [user.id, sha256(token), RESET_MINUTES],
  );
  return { ok: true as const, token };
}

export async function requestPasswordReset(emailRaw: string, requestOrigin = "", meta: { ip?: string | null } = {}) {
  const email = normalizeEmail(emailRaw);
  if (!email) return { token: null as string | null };
  if (!(await consumePasswordReset(email, meta.ip))) {
    console.warn("password reset rate limited");
    return { token: null };
  }
  if (await sandboxOnlyAccount(email)) {
    console.warn("password reset skipped: sandbox org");
    return { token: null };
  }
  const url = supabaseUrl();
  const service = process.env.SUPABASE_SERVICE_ROLE_KEY || "";
  if (url && service) {
    // Admin generate_link does not send. The message goes out through our mail module.
    // A missing address, a failed call, and a sent message all look the same to the caller.
    try {
      const response = await fetch(`${url.replace(/\/$/, "")}/auth/v1/admin/generate_link`, {
        method: "POST",
        headers: {
          apikey: service,
          Authorization: `Bearer ${service}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          type: "recovery",
          email,
          options: { redirect_to: passwordResetUrl(requestOrigin) },
        }),
      });
      const link = response.ok ? parseGenerateLink(await response.json().catch(() => ({}))) : null;
      if (link) {
        const landing = new URL(passwordResetUrl(requestOrigin));
        landing.searchParams.set("token_hash", link.hashedToken);
        landing.searchParams.set("type", "recovery");
        await deliverResetLink(email, landing.toString(), link.userId);
      }
    } catch (error) {
      console.error("password reset", error instanceof Error ? error.message : "failed");
    }
    return { token: null };
  }
  const user = await query<{ id: string }>(
    `SELECT id::text AS id FROM auth.users WHERE lower(email) = lower($1)`,
    [email],
  );
  if (!user.rows[0]) return { token: null };
  const token = newToken();
  await query(
    `INSERT INTO auth_password_resets (user_id, token_hash, expires_at) VALUES ($1, $2, now() + make_interval(mins => $3))`,
    [user.rows[0].id, sha256(token), RESET_MINUTES],
  );
  await writeAudit(await primaryOrg(user.rows[0].id), user.rows[0].id, "password_reset_requested", {});
  const link = `${passwordResetUrl(requestOrigin)}/${encodeURIComponent(token)}`;
  try {
    await deliverResetLink(email, link, user.rows[0].id);
  } catch (error) {
    console.error("password reset", error instanceof Error ? error.message : "failed");
  }
  return { token };
}

/** Check the new password before a recovery token is consumed. */
export async function completePasswordReset(input: {
  token?: string;
  tokenHash?: string;
  type?: string;
  password: string;
  confirm: string;
}) {
  if (input.password !== input.confirm) return { ok: false as const, error: "mismatch" as const };
  if (!passwordAcceptable(input.password)) return { ok: false as const, error: "weak" as const };
  let token = (input.token ?? "").trim();
  if (!token) {
    if ((input.type ?? "").trim() !== "recovery" || !(input.tokenHash ?? "").trim()) {
      return { ok: false as const, error: "expired" as const };
    }
    const verified = await verifyRecoveryTokenHash(input.tokenHash ?? "");
    if (!verified.ok) return { ok: false as const, error: "expired" as const };
    token = verified.token;
  }
  return resetPassword(token, input.password, input.confirm);
}

export async function resetPassword(token: string, password: string, confirm: string) {
  if (password !== confirm) return { ok: false as const, error: "mismatch" as const };
  if (!passwordAcceptable(password)) return { ok: false as const, error: "weak" as const };
  const row = await query<{ id: string; user_id: string; expires_at: Date; used_at: Date | null }>(
    `SELECT id::text, user_id::text, expires_at, used_at FROM auth_password_resets WHERE token_hash = $1`,
    [sha256(token)],
  );
  const reset = row.rows[0];
  if (!reset || reset.used_at || reset.expires_at.getTime() <= Date.now()) {
    return { ok: false as const, error: "expired" as const };
  }
  await setUserPassword(reset.user_id, password);
  await query(`UPDATE auth_password_resets SET used_at = now() WHERE user_id = $1 AND used_at IS NULL`, [reset.user_id]);
  await query(`UPDATE auth_sessions SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL`, [reset.user_id]);
  const account = await query<{ email: string }>(`SELECT email FROM auth.users WHERE id = $1`, [reset.user_id]);
  if (account.rows[0]?.email) await clearFailures(account.rows[0].email);
  await writeAudit(await primaryOrg(reset.user_id), reset.user_id, "password_reset", {});
  return { ok: true as const };
}

export async function describeReset(token: string) {
  const row = await query<{ expires_at: Date; used_at: Date | null }>(
    `SELECT expires_at, used_at FROM auth_password_resets WHERE token_hash = $1`,
    [sha256(token)],
  );
  const reset = row.rows[0];
  if (!reset || reset.used_at || reset.expires_at.getTime() <= Date.now()) return "expired" as const;
  return "ready" as const;
}

/** A recovery hash is ready only while its sent time is inside the 60-minute window. */
export function recoverySentAtStatus(sentAt: Date | null | undefined, now = Date.now()): "ready" | "expired" {
  if (!sentAt || Number.isNaN(sentAt.getTime())) return "expired";
  if (sentAt.getTime() + RESET_MINUTES * 60_000 <= now) return "expired";
  return "ready";
}

function pgCode(error: unknown) {
  return typeof error === "object" && error && "code" in error ? String((error as { code?: string }).code) : "";
}

/**
 * Read whether a GoTrue recovery link is still unused. This does not call
 * /verify, so opening the page does not consume the token.
 * `missing` means that store is not present or has no row.
 */
async function readRecoverySentAt(sql: string, hash: string, now: number): Promise<"ready" | "expired" | "missing"> {
  try {
    const row = await query<{ sent_at: Date | null }>(sql, [hash]);
    if (!row.rows[0]) return "missing";
    return recoverySentAtStatus(row.rows[0].sent_at, now);
  } catch (error) {
    const code = pgCode(error);
    if (code === "42P01" || code === "42703") return "missing";
    console.error("recovery link", error instanceof Error ? error.message : "failed");
    return "expired";
  }
}

/** Server-side check for /reset?token_hash. Invalid, used, and expired links are `expired`. */
export async function describeRecoveryHash(tokenHash: string, type: string, now = Date.now()): Promise<"ready" | "expired"> {
  const hash = tokenHash.trim();
  if (!hash || type.trim().toLowerCase() !== "recovery") return "expired";
  if (!process.env.DATABASE_URL) return "expired";
  const fromUser = await readRecoverySentAt(
    `SELECT recovery_sent_at AS sent_at FROM auth.users WHERE recovery_token = $1 AND recovery_token <> ''`,
    hash,
    now,
  );
  if (fromUser !== "missing") return fromUser;
  const fromToken = await readRecoverySentAt(
    `SELECT coalesce(u.recovery_sent_at, t.created_at AT TIME ZONE 'UTC') AS sent_at
       FROM auth.one_time_tokens t
       JOIN auth.users u ON u.id = t.user_id
      WHERE t.token_hash = $1 AND t.token_type::text = 'recovery_token'`,
    hash,
    now,
  );
  if (fromToken !== "missing") return fromToken;
  return "expired";
}

const TEAM_ROLES = new Set<OrgRole>(["admin", "manager", "accountant", "maintenance"]);

async function assertLastAdmin(orgId: string, userId: string, nextRole: OrgRole | null) {
  const row = await query<{ id: string; n: string }>(
    `SELECT user_id::text AS id, count(*) OVER ()::text AS n
       FROM org_members WHERE org_id = $1 AND role = 'admin' AND status = 'active'`,
    [orgId],
  );
  const admins = row.rows;
  const isAdmin = admins.some((admin) => admin.id === userId);
  const count = admins.length;
  if (isAdmin && count <= 1 && nextRole !== "admin") throw new FlowError("errors.lastAdmin");
}

export async function inviteMember(session: Session, input: { email: string; name: string; role: string }) {
  assertPerm(session, "team.manage");
  const email = normalizeEmail(input.email);
  if (!email) throw new FlowError("errors.email");
  if (!TEAM_ROLES.has(input.role as OrgRole)) throw new FlowError("errors.required");
  const role = input.role as OrgRole;
  const duplicate = await query(
    `SELECT 1 FROM profiles p JOIN org_members m ON m.user_id = p.id
      WHERE m.org_id = $1 AND lower(p.email::text) = lower($2) AND m.status <> 'removed'
     UNION ALL
     SELECT 1 FROM invitations
      WHERE org_id = $1 AND lower(email::text) = lower($2) AND status = 'pending' AND expires_at > now()`,
    [session.orgId, email],
  );
  if (duplicate.rows[0]) throw new FlowError("errors.emailTaken");
  await assertSeatAvailable(session.orgId, session.environment);
  const token = newToken();
  await query(
    `INSERT INTO invitations (org_id, kind, role, email, code_hash, expires_at, invited_by)
     VALUES ($1, 'team_member', $2::org_role, $3, $4, now() + make_interval(days => $5), $6)`,
    [session.orgId, role, email, sha256(token), INVITE_DAYS, session.userId],
  );
  const note = outboundNote(session.environment);
  await writeAudit(session.orgId, session.userId, "invite", { email, role, ...(note ? { note } : {}) });
  return { token, email };
}

export async function resendInvite(session: Session, invitationId: string) {
  assertPerm(session, "team.manage");
  const token = newToken();
  const updated = await query(
    `UPDATE invitations SET code_hash = $3, expires_at = now() + make_interval(days => $4), status = 'pending'
      WHERE id = $1 AND org_id = $2 AND kind = 'team_member' AND status = 'pending'`,
    [invitationId, session.orgId, sha256(token), INVITE_DAYS],
  );
  if (updated.rowCount !== 1) throw new FlowError("errors.notFound");
  await writeAudit(session.orgId, session.userId, "invite_resend", { invitationId });
  return { token };
}

export async function revokeInvite(session: Session, invitationId: string) {
  assertPerm(session, "team.manage");
  const updated = await query(
    `UPDATE invitations SET status = 'revoked' WHERE id = $1 AND org_id = $2 AND kind = 'team_member' AND status = 'pending'`,
    [invitationId, session.orgId],
  );
  if (updated.rowCount !== 1) throw new FlowError("errors.notFound");
  await writeAudit(session.orgId, session.userId, "invite_revoke", { invitationId });
}

export async function setMemberRole(session: Session, memberId: string, role: OrgRole) {
  assertPerm(session, "team.manage");
  if (!TEAM_ROLES.has(role)) throw new FlowError("errors.required");
  const member = await query<{ user_id: string; role: OrgRole; is_billing_owner: boolean }>(
    `SELECT user_id::text, role::text, is_billing_owner FROM org_members WHERE id = $1 AND org_id = $2 AND status = 'active'`,
    [memberId, session.orgId],
  );
  const row = member.rows[0];
  if (!row) throw new FlowError("errors.notFound");
  if (row.is_billing_owner && role !== "admin") throw new FlowError("errors.lastAdmin");
  await assertLastAdmin(session.orgId, row.user_id, role);
  if (row.user_id === session.userId) throw new FlowError("errors.ownRole");
  await query(`UPDATE org_members SET role = $3::org_role WHERE id = $1 AND org_id = $2`, [memberId, session.orgId, role]);
  await writeAudit(session.orgId, session.userId, "role_change", { memberId, role });
}

export async function setMemberActive(session: Session, memberId: string, active: boolean, confirmed = false) {
  assertPerm(session, "team.manage");
  if (!active && !confirmed) throw new FlowError("errors.confirm");
  const member = await query<{ user_id: string; role: OrgRole }>(
    `SELECT user_id::text, role::text FROM org_members WHERE id = $1 AND org_id = $2`,
    [memberId, session.orgId],
  );
  const row = member.rows[0];
  if (!row) throw new FlowError("errors.notFound");
  if (!active) {
    await assertLastAdmin(session.orgId, row.user_id, null);
    if (row.user_id === session.userId) throw new FlowError("errors.ownRole");
    await query(`UPDATE org_members SET status = 'suspended' WHERE id = $1 AND org_id = $2`, [memberId, session.orgId]);
    await query(`UPDATE auth_sessions SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL`, [row.user_id]);
    await writeAudit(session.orgId, session.userId, "deactivate", { memberId });
    return;
  }
  await assertSeatAvailable(session.orgId, session.environment);
  await query(`UPDATE org_members SET status = 'active' WHERE id = $1 AND org_id = $2`, [memberId, session.orgId]);
  await writeAudit(session.orgId, session.userId, "reactivate", { memberId });
}

export type InviteKind = "team_member" | "owner" | "tenant" | "unknown";

export type InviteView =
  | { state: "ready"; kind: "team_member"; email: string; role: OrgRole; firm: string; inviter: string }
  | { state: "ready"; kind: "owner" | "tenant"; email: string; firm: string; collectEmail: boolean }
  | { state: "expired" | "revoked" | "used" | "invalid" | "locked" | "timeout"; kind: InviteKind };

function dbTimeout(error: unknown) {
  const code = typeof error === "object" && error && "code" in error ? String((error as { code?: unknown }).code ?? "") : "";
  const message = error instanceof Error ? error.message : String(error);
  return (
    code === "55P03" ||
    code === "57014" ||
    /lock timeout|canceling statement due to statement timeout|statement timeout|timeout exceeded when trying to connect/i.test(message)
  );
}

export async function describeInvite(token: string, meta?: { ip: string | null }): Promise<InviteView> {
  try {
    return await describeInviteOnce(token, meta);
  } catch (error) {
    if (dbTimeout(error)) return { state: "timeout", kind: "unknown" };
    throw error;
  }
}

async function describeInviteOnce(token: string, meta?: { ip: string | null }): Promise<InviteView> {
  if (await tokenInviteLocked(token)) return { state: "locked", kind: "unknown" };
  if (meta && (await inviteAttemptLocked(meta.ip))) return { state: "locked", kind: "unknown" };
  const row = await withClient(async (client) => {
    await client.query(`SET statement_timeout = '8s'`);
    await client.query("BEGIN");
    try {
      await purgePortalInviteSecrets(client, "reset");
      const result = await client.query<{
        status: string;
        expires_at: Date;
        kind: string;
        email: string | null;
        contact_email: string | null;
        role: OrgRole | null;
        firm: string;
        inviter: string | null;
      }>(
        `SELECT i.status::text, i.expires_at, i.kind::text, i.email::text, c.email::text AS contact_email,
                i.role::text, o.name AS firm, p.display_name AS inviter
           FROM invitations i
           JOIN organizations o ON o.id = i.org_id
           LEFT JOIN contacts c ON c.id = i.contact_id AND c.org_id = i.org_id
           LEFT JOIN profiles p ON p.id = i.invited_by
          WHERE i.code_hash = $1`,
        [hashInviteToken(token)],
      );
      await client.query("COMMIT");
      return result;
    } catch (error) {
      try {
        await client.query("ROLLBACK");
      } catch {
        // The connection is already closing.
      }
      throw error;
    }
  });
  const invite = row.rows[0];
  const kind: InviteKind =
    invite?.kind === "team_member" || invite?.kind === "owner" || invite?.kind === "tenant" ? invite.kind : "unknown";
  const reject = (state: "expired" | "revoked" | "used" | "invalid", badKind: InviteKind): InviteView => {
    return { state, kind: badKind };
  };
  if (!invite) return reject("invalid", "unknown");
  if (invite.status === "accepted") return reject("used", kind);
  if (invite.status === "revoked") return reject("revoked", kind);
  if (invite.status !== "pending" || invite.expires_at.getTime() <= Date.now()) return reject("expired", kind);
  if (kind === "team_member" && invite.role && invite.email) {
    return { state: "ready", kind, email: invite.email, role: invite.role, firm: invite.firm, inviter: invite.inviter ?? "" };
  }
  if (kind === "owner" || kind === "tenant") {
    const email = portalShownEmail(invite.email, invite.contact_email);
    return { state: "ready", kind, email, firm: invite.firm, collectEmail: email === "" };
  }
  return reject("invalid", kind);
}

/** Hosted team logins must be provisioned by GoTrue, including identities and tokens. */
export async function upsertInvitedUser(client: Client, email: string, name: string, password: string) {
  const existing = await client.query<{ id: string; has_password: boolean; matches: boolean }>(
    `SELECT id::text,
            (encrypted_password IS NOT NULL AND btrim(encrypted_password) <> '') AS has_password,
            (encrypted_password IS NOT NULL AND encrypted_password = crypt($2, encrypted_password)) AS matches
       FROM auth.users WHERE lower(email) = lower($1)`,
    [email, password],
  );
  const account = existing.rows[0];
  // Like portal acceptance, never replace an established password.
  if (account?.has_password && !account.matches) return null;

  let id = account?.id ?? "";
  const url = supabaseUrl();
  if (url && !account?.has_password) {
    const service = process.env.SUPABASE_SERVICE_ROLE_KEY || "";
    if (!service) throw new Error("Invite login provisioning unavailable");
    const response = await fetch(
      `${url.replace(/\/$/, "")}/auth/v1/admin/users${id ? `/${encodeURIComponent(id)}` : ""}`,
      {
        method: id ? "PUT" : "POST",
        headers: {
          apikey: service,
          Authorization: `Bearer ${service}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ email, password, email_confirm: true }),
        signal: AbortSignal.timeout(8_000),
      },
    );
    if (!response.ok) throw new Error("Invite login provisioning unavailable");
    const user = parseGotrueUserId(await response.json().catch(() => ({})));
    if (!user || (id && user.id !== id)) throw new Error("Invite login provisioning unavailable");
    id = user.id;
  } else if (!url && !account?.has_password) {
    // The local Postgres stub has no GoTrue service.
    if (id) {
      await client.query(
        `UPDATE auth.users
            SET encrypted_password = crypt($2, gen_salt('bf')),
                email_confirmed_at = coalesce(email_confirmed_at, now()),
                updated_at = now()
          WHERE id = $1`,
        [id, password],
      );
    } else {
      const inserted = await client.query<{ id: string }>(
        `INSERT INTO auth.users (id, email, encrypted_password, email_confirmed_at, raw_user_meta_data, role, aud)
         VALUES (gen_random_uuid(), $1, crypt($2, gen_salt('bf')), now(), $3::jsonb, 'authenticated', 'authenticated')
         RETURNING id::text`,
        [email, password, JSON.stringify({ name })],
      );
      id = inserted.rows[0].id;
    }
  }
  await client.query(
    `INSERT INTO profiles (id, display_name, email, locale) VALUES ($1, $2, $3, 'zh-TW')
     ON CONFLICT (id) DO UPDATE SET display_name = EXCLUDED.display_name, email = EXCLUDED.email`,
    [id, name, email],
  );
  return id;
}

async function notePortalReject(token: string, ip: string | null) {
  await query(`SELECT crypt($1, gen_salt('bf'))`, ["portal-email"]);
  await noteTokenInviteAttempt(token);
  await noteBadInvite(ip);
}

function portalBindError(error: unknown) {
  if (dbTimeout(error)) return "timeout" as const;
  const message = error instanceof Error ? error.message : String(error);
  if (/contacts_org_user_(owner|tenant)_uniq|contacts_org_user_uniq/i.test(message)) return "bound" as const;
  if (authEmailTaken(error)) return "auth" as const;
  return null;
}

/** Create the login and set its password inside one savepoint so a taken email rolls both back. */
async function provisionAcceptedLogin(
  client: Client,
  input: { email: string; name: string; phone: string | null; password: string },
) {
  await client.query(`SAVEPOINT portal_accept_user`);
  try {
    await client.query(`SET LOCAL ROLE service_role`);
    const user = await client.query<{ id: string }>(
      `SELECT app.provision_portal_user($1, $2, $3) AS id`,
      [input.email, input.name, input.phone],
    );
    await client.query(`RESET ROLE`);
    await client.query(
      `UPDATE auth.users
          SET encrypted_password = crypt($2, gen_salt('bf')),
              email_confirmed_at = coalesce(email_confirmed_at, now()),
              updated_at = now()
        WHERE id = $1`,
      [user.rows[0].id, input.password],
    );
    await client.query(`RELEASE SAVEPOINT portal_accept_user`);
    return user.rows[0].id;
  } catch (error) {
    await client.query(`ROLLBACK TO SAVEPOINT portal_accept_user`);
    await client.query(`RESET ROLE`);
    if (authEmailTaken(error)) return null;
    throw error;
  }
}

async function acceptPortalInvite(
  token: string,
  password: string,
  meta: RequestMeta,
  kind: "owner" | "tenant",
  emailRaw: string,
  sessionEmail: string,
) {
  const pending = await query<{
    id: string;
    org_id: string;
    contact_id: string;
    user_id: string | null;
    login_email: string | null;
    contact_email: string | null;
    display_name: string;
    phone_e164: string | null;
  }>(
    `SELECT i.id::text, i.org_id::text, i.contact_id::text, c.user_id::text AS user_id,
            u.email::text AS login_email, c.email::text AS contact_email, c.display_name, c.phone_e164
       FROM invitations i
       JOIN contacts c ON c.id = i.contact_id AND c.org_id = i.org_id
       LEFT JOIN auth.users u ON u.id = c.user_id
      WHERE i.code_hash = $1 AND i.kind = $2::invitation_kind
        AND i.status = 'pending' AND i.expires_at > now()`,
    [hashInviteToken(token), kind],
  );
  const row = pending.rows[0];
  if (!row) return { ok: false as const, error: "invalid" as const, kind };

  let target = portalShownEmail(row.login_email, row.contact_email);
  if (!target) {
    const chosen = normalizeEmail(emailRaw);
    if (!chosen || mintedLoginEmail(chosen)) {
      await notePortalReject(token, meta.ip);
      return { ok: false as const, error: "email" as const, kind };
    }
    target = chosen;
  }

  const signedIn = sessionEmail.trim().toLowerCase();
  if (signedIn && signedIn !== target.trim().toLowerCase()) {
    return { ok: false as const, error: "account" as const, kind };
  }

  const account = await query<{ id: string; has_password: boolean; matches: boolean }>(
    `SELECT id::text AS id,
            (encrypted_password IS NOT NULL AND btrim(encrypted_password) <> '') AS has_password,
            (encrypted_password IS NOT NULL AND encrypted_password = crypt($2, encrypted_password)) AS matches
       FROM auth.users
      WHERE lower(email) = lower($1)`,
    [target, password],
  );
  const existing = account.rows[0];
  if (existing?.has_password && !existing.matches) {
    await notePortalReject(token, meta.ip);
    return { ok: false as const, error: "auth" as const, kind };
  }

  let saved: { userId: string } | { conflict: true } | null = null;
  try {
    saved = await withClient(async (client) => {
      try {
        await client.query("BEGIN");
        await client.query(`SET LOCAL statement_timeout = '8s'`);
        await client.query(`SET LOCAL lock_timeout = '3s'`);
        const invite = await client.query(
          `SELECT id FROM invitations WHERE id = $1 AND status = 'pending' AND expires_at > now() FOR UPDATE`,
          [row.id],
        );
        if (!invite.rows[0]) {
          await client.query("ROLLBACK");
          return null;
        }
        let userId = existing?.id ?? row.user_id ?? "";
        if (!userId) {
          const created = await provisionAcceptedLogin(client, {
            email: target,
            name: row.display_name,
            phone: row.phone_e164,
            password,
          });
          if (!created) {
            await client.query("ROLLBACK");
            return { conflict: true as const };
          }
          userId = created;
        } else if (!existing?.has_password) {
          await client.query(
            `UPDATE auth.users
                SET email = $2,
                    encrypted_password = crypt($3, gen_salt('bf')),
                    email_confirmed_at = coalesce(email_confirmed_at, now()),
                    updated_at = now()
              WHERE id = $1`,
            [userId, target, password],
          );
          await client.query(`UPDATE profiles SET email = $2 WHERE id = $1`, [userId, target]);
        }
        const bound = await client.query(
          `UPDATE contacts
              SET user_id = $2,
                  email = CASE
                    WHEN email IS NULL OR lower(email::text) LIKE '%@demo.condola.local' THEN $3
                    ELSE email
                  END,
                  updated_at = now()
            WHERE id = $1
              AND org_id = $4
              AND (user_id IS NULL OR user_id = $2 OR user_id = $5)`,
          [row.contact_id, userId, target, row.org_id, row.user_id],
        );
        if (bound.rowCount !== 1) {
          await client.query("ROLLBACK");
          return null;
        }
        await client.query(
          `UPDATE invitations SET email = $2, status = 'accepted', accepted_by = $3, accepted_at = now() WHERE id = $1`,
          [row.id, target, userId],
        );
        await deletePortalInviteSecret(client, row.id);
        await client.query("COMMIT");
        return { userId };
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      }
    });
  } catch (error) {
    const bind = portalBindError(error);
    if (bind === "timeout") return { ok: false as const, error: "timeout" as const, kind };
    if (bind === "auth") {
      await notePortalReject(token, meta.ip);
      return { ok: false as const, error: bind, kind };
    }
    if (bind === "bound") return { ok: false as const, error: "bound" as const, kind };
    console.error("portal accept failed", error);
    return { ok: false as const, error: "failed" as const, kind };
  }
  if (saved && "conflict" in saved) {
    await notePortalReject(token, meta.ip);
    return { ok: false as const, error: "auth" as const, kind };
  }
  if (!saved || !("userId" in saved)) return { ok: false as const, error: "invalid" as const, kind };
  await writeAudit(row.org_id, saved.userId, "portal_invite_accept", {
    kind,
    contactId: row.contact_id,
    invitationId: row.id,
  });
  const sessionToken = await createSession(saved.userId, true, meta);
  return {
    ok: true as const,
    token: sessionToken,
    role: null,
    kind,
    destination: kind === "tenant" ? "/t" : "/o/statements",
  };
}

export async function acceptInvite(
  token: string,
  name: string,
  password: string,
  confirm: string,
  meta: RequestMeta,
  emailRaw = "",
  sessionEmail = "",
  consent = false,
) {
  try {
    return await withInviteLock(token, () => acceptInviteOnce(token, name, password, confirm, meta, emailRaw, sessionEmail, consent));
  } catch (error) {
    if (dbTimeout(error)) return { ok: false as const, error: "timeout" as const, kind: "unknown" as const };
    throw error;
  }
}

async function acceptInviteOnce(
  token: string,
  name: string,
  password: string,
  confirm: string,
  meta: RequestMeta,
  emailRaw = "",
  sessionEmail = "",
  consent = false,
) {
  const view = await describeInvite(token, meta);
  if (view.state !== "ready") return { ok: false as const, error: view.state, kind: view.kind };
  if (teamInviteBlocked(view.kind, consent)) {
    return { ok: false as const, error: "consent" as const, kind: "team_member" as const };
  }
  if (view.kind === "owner" || view.kind === "tenant") {
    if (!passwordAcceptable(password)) return { ok: false as const, error: "weak" as const, kind: view.kind };
    return acceptPortalInvite(token, password, meta, view.kind, emailRaw, sessionEmail);
  }
  if (password !== confirm) return { ok: false as const, error: "mismatch" as const, kind: view.kind };
  if (!passwordAcceptable(password)) return { ok: false as const, error: "weak" as const, kind: view.kind };
  if (!name.trim()) return { ok: false as const, error: "required" as const, kind: "team_member" as const };
  return withClient((client) => acceptTeamInvite(client, token, name, password, meta));
}

/** Keep provisioning and invitation consumption in the same acceptance transaction. */
export async function acceptTeamInvite(client: Client, token: string, name: string, password: string, meta: RequestMeta) {
  try {
    await client.query("BEGIN");
    const invite = await client.query<{ id: string; org_id: string; role: OrgRole; email: string }>(
      `SELECT id::text, org_id::text, role::text, email::text FROM invitations
        WHERE code_hash = $1 AND kind = 'team_member' AND status = 'pending' AND expires_at > now()
        FOR UPDATE`,
      [hashInviteToken(token)],
    );
    const row = invite.rows[0];
    if (!row) {
      await client.query("ROLLBACK");
      return { ok: false as const, error: "used" as const, kind: "team_member" as const };
    }
    let userId: string | null;
    try {
      // GoTrue commits independently. On a later rollback, retry requires the
      // created account's password and leaves the invitation available.
      userId = await upsertInvitedUser(client, row.email, name.trim(), password);
    } catch {
      await client.query("ROLLBACK");
      return { ok: false as const, error: "failed" as const, kind: "team_member" as const };
    }
    if (!userId) {
      await client.query("ROLLBACK");
      return { ok: false as const, error: "auth" as const, kind: "team_member" as const };
    }
    const member = await client.query(
      `SELECT status::text FROM org_members WHERE org_id = $1 AND user_id = $2`,
      [row.org_id, userId],
    );
    if (member.rows[0]?.status === "active") {
      await client.query("ROLLBACK");
      return { ok: false as const, error: "used" as const, kind: "team_member" as const };
    }
    if (member.rows[0]) {
      await client.query(
        `UPDATE org_members SET role = $3::org_role, status = 'active' WHERE org_id = $1 AND user_id = $2`,
        [row.org_id, userId, row.role],
      );
    } else {
      await client.query(
        `INSERT INTO org_members (org_id, user_id, role, status) VALUES ($1, $2, $3::org_role, 'active')`,
        [row.org_id, userId, row.role],
      );
    }
    await client.query(
      `UPDATE invitations SET status = 'accepted', accepted_by = $2, accepted_at = now() WHERE id = $1`,
      [row.id, userId],
    );
    await deletePortalInviteSecret(client, row.id);
    await client.query("COMMIT");
    try {
      await writeConsent(userId, "invite");
    } catch (error) {
      console.error("invite consent", error instanceof Error ? error.message : "failed");
      return { ok: false as const, error: "consent" as const, kind: "team_member" as const };
    }
    await writeAudit(row.org_id, userId, "invite_accept", { role: row.role });
    const sessionToken = await createSession(userId, true, meta);
    return { ok: true as const, token: sessionToken, role: row.role, kind: "team_member" as const };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  }
}

export async function listSessions(userId: string) {
  const result = await query<{
    id: string;
    user_agent: string | null;
    ip: string | null;
    last_active_at: Date;
    created_at: Date;
  }>(
    `SELECT id::text, user_agent, ip, last_active_at, created_at
       FROM auth_sessions
      WHERE user_id = $1 AND revoked_at IS NULL AND expires_at > now()
      ORDER BY last_active_at DESC`,
    [userId],
  );
  return result.rows;
}

export async function revokeSession(userId: string, sessionId: string) {
  await query(
    `UPDATE auth_sessions SET revoked_at = now() WHERE id = $1 AND user_id = $2 AND revoked_at IS NULL`,
    [sessionId, userId],
  );
  await writeAudit(await primaryOrg(userId), userId, "sign_out", { sessionId });
}

export async function revokeAllSessions(userId: string) {
  await query(
    `UPDATE auth_sessions SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL`,
    [userId],
  );
  try {
    await query(`SELECT app.end_auth_sessions($1::uuid)`, [userId]);
  } catch (error) {
    console.error("end_auth_sessions", error);
  }
  try {
    await writeAudit(await primaryOrg(userId), userId, "sign_out", { scope: "all" });
  } catch (error) {
    console.error("sign_out audit", error);
  }
}

export async function revokeOtherSessions(userId: string, currentSessionId: string) {
  await query(
    `UPDATE auth_sessions SET revoked_at = now()
      WHERE user_id = $1 AND id <> $2 AND revoked_at IS NULL`,
    [userId, currentSessionId],
  );
  await writeAudit(await primaryOrg(userId), userId, "sign_out_others", {});
}

export async function changePassword(session: Session, current: string, password: string, confirm: string) {
  if (password !== confirm) throw new FlowError("errors.mismatch");
  if (!passwordAcceptable(password)) throw new FlowError("errors.weakPassword");
  const email = session.email;
  const userId = await verifyPassword(email, current);
  if (userId !== session.userId) throw new FlowError("errors.authInvalid");
  await setUserPassword(session.userId, password);
  await query(
    `UPDATE auth_sessions SET revoked_at = now() WHERE user_id = $1 AND id <> $2 AND revoked_at IS NULL`,
    [session.userId, session.sessionId],
  );
  await writeAudit(session.orgId, session.userId, "password_change", {});
}

export async function beginMfa(session: Session) {
  const required = await firmRequiresMfa(session.userId);
  const factor = await mfaRow(session.userId);
  if (factor?.enabled && required) throw new FlowError("errors.mfaRequired");
  const secret = randomBase32();
  const challengeId = await openChallenge(session.userId, "enroll", true, secret);
  return { challengeId, secret, otpauth: otpauthUrl(secret, session.email) };
}

export async function confirmMfa(session: Session, challengeId: string, code: string) {
  const challenge = await loadChallenge(challengeId);
  if (!challenge || challenge.user_id !== session.userId || challenge.purpose !== "enroll" || !challenge.totp_secret) {
    throw new FlowError("errors.authInvalid");
  }
  if (!acceptSecondFactor(challenge.totp_secret, code)) throw new FlowError("errors.authInvalid");
  const codes = backupCodes();
  await query(
    `INSERT INTO user_mfa (user_id, totp_secret, enabled, backup_code_hashes, confirmed_at)
     VALUES ($1, $2, true, $3, now())
     ON CONFLICT (user_id) DO UPDATE
       SET totp_secret = EXCLUDED.totp_secret, enabled = true, backup_code_hashes = EXCLUDED.backup_code_hashes,
           confirmed_at = now(), updated_at = now()`,
    [session.userId, challenge.totp_secret, codes.map((item) => sha256(item))],
  );
  await query(`DELETE FROM auth_challenges WHERE id = $1`, [challengeId]);
  await writeAudit(session.orgId, session.userId, "mfa_enabled", {});
  return codes;
}

export async function disableMfa(session: Session) {
  if (await firmRequiresMfa(session.userId)) throw new FlowError("errors.mfaRequired");
  await query(
    `UPDATE user_mfa SET enabled = false, totp_secret = NULL, backup_code_hashes = '{}', updated_at = now() WHERE user_id = $1`,
    [session.userId],
  );
  await writeAudit(session.orgId, session.userId, "mfa_disabled", {});
}

export async function setRequireMfa(session: Session, required: boolean) {
  assertPerm(session, "settings.edit");
  const { tx } = await import("./db");
  await tx(session.userId, async (client) => {
    await client.query(
      `UPDATE organizations
          SET settings = jsonb_set(coalesce(settings, '{}'::jsonb), '{require_2fa}', to_jsonb($2::boolean), true)
        WHERE id = $1`,
      [session.orgId, required],
    );
  });
  await writeAudit(session.orgId, session.userId, "require_2fa", { required });
}

export async function ownerPrivacy(orgId: string): Promise<OwnerPrivacy & { name: string }> {
  const row = await query<{ settings: unknown; name: string }>(
    `SELECT settings, name FROM organizations WHERE id = $1`,
    [orgId],
  );
  return { ...privacyFromSettings(row.rows[0]?.settings ?? null), name: row.rows[0]?.name ?? "" };
}

export async function setOwnerPrivacy(session: Session, input: OwnerPrivacy) {
  assertPerm(session, "settings.edit");
  const { tx } = await import("./db");
  await tx(session.userId, async (client) => {
    await client.query(
      `UPDATE organizations
          SET settings = jsonb_set(
                jsonb_set(coalesce(settings, '{}'::jsonb), '{show_tenant_name}', to_jsonb($2::boolean), true),
                '{show_tenant_phone}', to_jsonb($3::boolean), true)
        WHERE id = $1`,
      [session.orgId, input.showName, input.showPhone],
    );
  });
  await writeAudit(session.orgId, session.userId, "owner_privacy", input);
}

export async function tenantDisplayNames(orgId: string) {
  const rows = await query<{ display_name: string }>(
    `SELECT display_name FROM contacts WHERE org_id = $1 AND is_tenant AND archived_at IS NULL`,
    [orgId],
  );
  return rows.rows.map((row) => row.display_name);
}

export async function mfaStatus(userId: string) {
  const factor = await mfaRow(userId);
  return { enabled: Boolean(factor?.enabled), required: await firmRequiresMfa(userId) };
}

export { sha256 };
