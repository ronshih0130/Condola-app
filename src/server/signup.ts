import { createHash, randomBytes } from "node:crypto";
import type { Client } from "pg";
import { cookies } from "next/headers";
import { writeAudit } from "./audit";
import { createSession, normalizeEmail, SESSION_COOKIE, type RequestMeta } from "./auth";
import { firmDisplayName, normalizePartnerCode } from "./billing";
import { query, withClient } from "./db";
import { recordFunnel } from "./funnel";
import { previewPartnerCodeOn, redeemPartnerCode } from "./partners";
import { countryByCode } from "@/countries";
import { normalizePhone } from "./lease-rules";
import { passwordAcceptable } from "./password";
import { seedSandboxForNewFirm } from "./sandbox";
import { signupConsentMetadata, signupRequestBody, type SignupConsentMetadata } from "./legal-versions";
import { gotrueEndpoint, gotrueVerifyBody, parseGotrueUserId, parseSupabaseSignup, signupConfirmUrl } from "./signup-gotrue";

const VERIFY_HOURS = 24;

/** GoTrue's default JWT lifetime. supabase/config.toml sets the same value for local Auth. */
export const GOTRUE_JWT_EXPIRY_SECONDS = 3600;

/**
 * Implicit confirm links mint a user JWT. Reject one that is already expired
 * or whose exp - iat is longer than the documented GoTrue JWT expiry.
 * Returns a status only. Callers must not log the token.
 */
export function gotrueAccessTokenLifetime(
  accessToken: string,
  nowSeconds = Math.floor(Date.now() / 1000),
): "ok" | "expired" | "long" | "malformed" {
  const parts = accessToken.split(".");
  if (parts.length !== 3 || !parts[1]) return "malformed";
  try {
    const payload = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8")) as { exp?: unknown; iat?: unknown };
    if (typeof payload.exp !== "number" || typeof payload.iat !== "number") return "malformed";
    if (!Number.isFinite(payload.exp) || !Number.isFinite(payload.iat)) return "malformed";
    if (payload.exp <= nowSeconds) return "expired";
    if (payload.exp - payload.iat > GOTRUE_JWT_EXPIRY_SECONDS) return "long";
    return "ok";
  } catch {
    return "malformed";
  }
}

export type SignupError = "duplicate" | "weak" | "mismatch" | "email" | "required" | "consent";

function sha256(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

function newToken() {
  return randomBytes(32).toString("base64url");
}

function supabaseAuth() {
  const url = (process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL || "").replace(/\/$/, "");
  const anon = process.env.SUPABASE_ANON_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || "";
  const service = process.env.SUPABASE_SERVICE_ROLE_KEY || "";
  return { url, anon, service };
}

/** Local and dev can show the confirm link. Staging and production rely on Supabase email. */
export function signupLinksExposed() {
  if (supabaseAuth().url) return false;
  const name = process.env.CONDOLA_ENV?.trim().toLowerCase();
  return name !== "production" && name !== "staging" && name !== "staging-real";
}

type ExistingUser = { id: string; email_confirmed_at: Date | null; has_firm: boolean; encrypted_password: string | null };

/** One connection and one transaction. Each query() used to open its own socket. */
async function inTx<T>(fn: (client: Client) => Promise<T>): Promise<T> {
  return withClient(async (client) => {
    await client.query("BEGIN");
    try {
      const value = await fn(client);
      await client.query("COMMIT");
      return value;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    }
  });
}

async function findUser(client: Client, email: string) {
  const row = await client.query<ExistingUser>(
    `SELECT u.id::text AS id, u.email_confirmed_at, u.encrypted_password,
            EXISTS (
              SELECT 1 FROM org_members m
                JOIN organizations o ON o.id = m.org_id
               WHERE m.user_id = u.id AND m.status = 'active' AND o.environment = 'live'
            ) AS has_firm
       FROM auth.users u
      WHERE lower(u.email) = lower($1)`,
    [email],
  );
  return row.rows[0] ?? null;
}

async function passwordMatches(client: Client, userId: string, password: string) {
  const row = await client.query<{ ok: boolean }>(
    `SELECT encrypted_password IS NOT NULL AND encrypted_password = crypt($2, encrypted_password) AS ok
       FROM auth.users WHERE id = $1`,
    [userId, password],
  );
  return Boolean(row.rows[0]?.ok);
}

async function draftCode(client: Client, raw: string) {
  const preview = await previewPartnerCodeOn(client, raw);
  return preview.state === "valid" ? preview.code : null;
}

/** New confirm token only. Does not send mail and does not touch the partner draft. */
async function rotateVerification(client: Client, userId: string, email: string) {
  const token = newToken();
  await client.query(
    `WITH closed AS (
       UPDATE signup_verifications SET used_at = now() WHERE user_id = $1 AND used_at IS NULL
       RETURNING id
     )
     INSERT INTO signup_verifications (user_id, email, token_hash, expires_at)
     SELECT $1, $2, $3, now() + make_interval(hours => $4::int)
      WHERE (SELECT count(*) FROM closed) >= 0`,
    [userId, email, sha256(token), VERIFY_HOURS],
  );
  return token;
}

/**
 * Profile, funnel row, partner draft, and the confirm token. One statement.
 * Does not send mail. GoTrue already did that on the signup call.
 */
async function finishUnconfirmed(client: Client, userId: string, email: string, partnerCode: string | null) {
  const token = newToken();
  await client.query(
    `WITH profile AS (
       INSERT INTO profiles (id, display_name, email, locale)
       VALUES ($1, $2, $3, 'zh-TW')
       ON CONFLICT (id) DO UPDATE SET email = EXCLUDED.email
       RETURNING id
     ), funnel AS (
       INSERT INTO funnel_events (event_type, user_id, email, detail)
       SELECT 'signup_started', $1::uuid, $3, '{}'::jsonb
        WHERE NOT EXISTS (
          SELECT 1 FROM funnel_events WHERE event_type = 'signup_started' AND user_id = $1::uuid
        )
       RETURNING id
     ), draft AS (
       INSERT INTO signup_drafts (user_id, partner_code) VALUES ($1, $4)
       ON CONFLICT (user_id) DO UPDATE SET partner_code = EXCLUDED.partner_code
       RETURNING user_id
     ), closed AS (
       UPDATE signup_verifications SET used_at = now() WHERE user_id = $1 AND used_at IS NULL
       RETURNING id
     )
     INSERT INTO signup_verifications (user_id, email, token_hash, expires_at)
     SELECT $1, $3, $5, now() + make_interval(hours => $6::int)
      WHERE (SELECT count(*) FROM profile)
          + (SELECT count(*) FROM funnel)
          + (SELECT count(*) FROM draft)
          + (SELECT count(*) FROM closed) >= 0`,
    [userId, email.split("@")[0], email, partnerCode, sha256(token), VERIFY_HOURS],
  );
  return token;
}

async function supabaseSignUp(email: string, password: string, requestOrigin: string, metadata: SignupConsentMetadata) {
  const { url, anon } = supabaseAuth();
  if (!url || !anon) return null;
  const redirectTo = signupConfirmUrl(requestOrigin);
  const response = await fetch(gotrueEndpoint(url, "/auth/v1/signup", redirectTo), {
    method: "POST",
    headers: { apikey: anon, "Content-Type": "application/json" },
    body: JSON.stringify(signupRequestBody(email, password, metadata)),
  });
  const body = await response.json().catch(() => ({}));
  const parsed = parseSupabaseSignup(response.status, body);
  if (parsed === "duplicate" || parsed === "unavailable") return parsed;
  return parsed;
}

async function supabaseResend(email: string, requestOrigin: string) {
  const { url, anon } = supabaseAuth();
  if (!url || !anon) return;
  const redirectTo = signupConfirmUrl(requestOrigin);
  await fetch(gotrueEndpoint(url, "/auth/v1/resend", redirectTo), {
    method: "POST",
    headers: { apikey: anon, "Content-Type": "application/json" },
    body: JSON.stringify({ type: "signup", email }),
  });
}

async function markConfirmed(userId: string, email: string) {
  await inTx(async (client) => {
    const updated = await client.query(
      `UPDATE auth.users SET email_confirmed_at = now(), updated_at = now()
        WHERE id = $1 AND email_confirmed_at IS NULL`,
      [userId],
    );
    if (updated.rowCount === 1) {
      await recordFunnel("email_confirmed", { userId, email }, client);
      await writeAudit(null, userId, "email_confirmed", { email }, client);
      return;
    }
    const prior = await client.query(
      `SELECT 1 FROM funnel_events WHERE event_type = 'email_confirmed' AND user_id = $1 LIMIT 1`,
      [userId],
    );
    if (!prior.rows[0]) await recordFunnel("email_confirmed", { userId, email }, client);
  });
}

export async function startSignup(input: {
  email: string;
  password: string;
  confirm: string;
  partnerCode: string;
  origin: string;
  meta: RequestMeta;
  consent?: boolean;
}): Promise<
  | { ok: true; status: "verify"; email: string; devToken: string | null }
  | { ok: true; status: "firm"; token: string }
  | { ok: false; error: SignupError }
> {
  if (input.consent !== true) return { ok: false, error: "consent" };
  const acceptedAt = new Date();
  const metadata = signupConsentMetadata(acceptedAt);
  const email = normalizeEmail(input.email);
  const looked = await inTx(async (client) => {
    await client.query(`SELECT crypt($1, gen_salt('bf'))`, [input.password || "placeholder"]);
    if (!email) return { kind: "email" as const };
    if (input.password !== input.confirm) return { kind: "mismatch" as const };
    if (!passwordAcceptable(input.password)) return { kind: "weak" as const };
    const existing = await findUser(client, email);
    const code = await draftCode(client, input.partnerCode);
    if (!existing) return { kind: "new" as const, code };
    const matches = await passwordMatches(client, existing.id, input.password);
    return { kind: "existing" as const, existing, matches, code };
  });
  if (looked.kind === "email" || !email) return { ok: false, error: "email" };
  if (looked.kind === "mismatch") return { ok: false, error: "mismatch" };
  if (looked.kind === "weak") return { ok: false, error: "weak" };

  if (looked.kind === "existing") {
    const { existing, matches, code } = looked;
    if (existing.has_firm || existing.email_confirmed_at) {
      if (existing.email_confirmed_at && matches && !existing.has_firm) {
        await inTx((client) =>
          client.query(
            `INSERT INTO signup_drafts (user_id, partner_code) VALUES ($1, $2)
             ON CONFLICT (user_id) DO UPDATE SET partner_code = EXCLUDED.partner_code`,
            [existing.id, code],
          ),
        );
        const token = await createSession(existing.id, true, input.meta);
        return { ok: true, status: "firm", token };
      }
      return { ok: false, error: "duplicate" };
    }
    // Leave auth.users alone. An admin password update clears confirmation_token and
    // confirmation_sent_at, which expires the link already in the inbox, and this path does not send a new email.
    const token = await inTx((client) => finishUnconfirmed(client, existing.id, email, code));
    return { ok: true, status: "verify", email, devToken: signupLinksExposed() ? token : null };
  }

  const remote = await supabaseSignUp(email, input.password, input.origin, metadata);
  if (remote === "duplicate") return { ok: false, error: "duplicate" };
  if (remote === "unavailable") return { ok: false, error: "required" };
  let userId = remote?.id ?? "";
  const confirmed = remote?.confirmed ?? false;
  const saved = await inTx(async (client) => {
    if (!remote) {
      const inserted = await client.query<{ id: string }>(
        `INSERT INTO auth.users (id, email, encrypted_password, raw_user_meta_data, role, aud)
         VALUES (gen_random_uuid(), $1, crypt($2, gen_salt('bf')), $3::jsonb, 'authenticated', 'authenticated')
         RETURNING id::text`,
        [email, input.password, JSON.stringify(metadata)],
      );
      userId = inserted.rows[0].id;
    }
    const token = await finishUnconfirmed(client, userId, email, looked.code);
    return token;
  }).catch((error: unknown) => {
    const code = typeof error === "object" && error && "code" in error ? String((error as { code: unknown }).code) : "";
    if (code === "23505") return "duplicate" as const;
    throw error;
  });
  if (saved === "duplicate") return { ok: false, error: "duplicate" };
  if (confirmed) {
    await markConfirmed(userId, email);
    const token = await createSession(userId, true, input.meta);
    return { ok: true, status: "firm", token };
  }
  return { ok: true, status: "verify", email, devToken: signupLinksExposed() ? saved : null };
}

export async function resendSignup(emailRaw: string, origin: string) {
  const email = normalizeEmail(emailRaw);
  if (!email) return { devToken: null as string | null };
  const sent = await inTx(async (client) => {
    const existing = await findUser(client, email);
    if (!existing || existing.email_confirmed_at || existing.has_firm) return null;
    return rotateVerification(client, existing.id, email);
  });
  if (!sent) return { devToken: null as string | null };
  await supabaseResend(email, origin);
  return { devToken: signupLinksExposed() ? sent : null };
}

export async function changeSignupEmail(input: { currentEmail: string; password: string; nextEmail: string; origin: string }) {
  const current = normalizeEmail(input.currentEmail);
  const next = normalizeEmail(input.nextEmail);
  if (!current || !next) return { ok: false as const, error: "email" as const };
  const checked = await inTx(async (client) => {
    await client.query(`SELECT crypt($1, gen_salt('bf'))`, [input.password || "placeholder"]);
    const existing = await findUser(client, current);
    if (!existing || existing.email_confirmed_at || existing.has_firm) return { ok: false as const, error: "duplicate" as const };
    if (!(await passwordMatches(client, existing.id, input.password))) return { ok: false as const, error: "duplicate" as const };
    const taken = await findUser(client, next);
    if (taken && taken.id !== existing.id) return { ok: false as const, error: "duplicate" as const };
    return { ok: true as const, id: existing.id };
  });
  if (!checked.ok) return checked;
  const { url, service } = supabaseAuth();
  if (url && service) {
    const response = await fetch(`${url}/auth/v1/admin/users/${checked.id}`, {
      method: "PUT",
      headers: { apikey: service, Authorization: `Bearer ${service}`, "Content-Type": "application/json" },
      body: JSON.stringify({ email: next, email_confirm: false }),
    });
    if (!response.ok) return { ok: false as const, error: "required" as const };
  }
  const token = await inTx(async (client) => {
    if (!url || !service) {
      await client.query(`UPDATE auth.users SET email = $2, email_confirmed_at = NULL, updated_at = now() WHERE id = $1`, [checked.id, next]);
    }
    await client.query(`UPDATE profiles SET email = $2 WHERE id = $1`, [checked.id, next]);
    return rotateVerification(client, checked.id, next);
  });
  await supabaseResend(next, input.origin);
  return { ok: true as const, email: next, devToken: signupLinksExposed() ? token : null };
}

export async function confirmSignupToken(token: string, meta: RequestMeta) {
  const raw = token.trim();
  if (!raw) return { ok: false as const, error: "expired" as const };
  const row = await query<{ user_id: string; email: string }>(
    `UPDATE signup_verifications
        SET used_at = now()
      WHERE token_hash = $1 AND used_at IS NULL AND expires_at > now()
      RETURNING user_id::text, email`,
    [sha256(raw)],
  );
  const hit = row.rows[0];
  if (!hit) return { ok: false as const, error: "expired" as const };
  await markConfirmed(hit.user_id, hit.email);
  const sessionToken = await createSession(hit.user_id, true, meta);
  return { ok: true as const, token: sessionToken };
}

/** Record a confirm JWT so a second presentation is rejected. The raw token is not stored. */
export async function claimGotrueConfirmToken(accessToken: string) {
  // A JWT cannot still be valid after GOTRUE_JWT_EXPIRY_SECONDS. Drop replay
  // rows older than twice that, so a late clock skew cannot revive one.
  await query(
    `DELETE FROM gotrue_confirm_uses
      WHERE used_at < now() - make_interval(secs => $1)`,
    [GOTRUE_JWT_EXPIRY_SECONDS * 2],
  );
  const row = await query<{ token_hash: string }>(
    `INSERT INTO gotrue_confirm_uses (token_hash) VALUES ($1)
     ON CONFLICT (token_hash) DO NOTHING
     RETURNING token_hash`,
    [sha256(accessToken)],
  );
  return Boolean(row.rows[0]);
}

export async function releaseGotrueConfirmToken(accessToken: string) {
  await query(`DELETE FROM gotrue_confirm_uses WHERE token_hash = $1`, [sha256(accessToken)]);
}

export async function confirmSupabaseAccessToken(accessToken: string, meta: RequestMeta) {
  const raw = accessToken.trim();
  // GoTrue GET /auth/v1/user does not consume the JWT. Lifetime is checked
  // here against jwt_expiry (3600s). Reuse is rejected by gotrue_confirm_uses.
  if (gotrueAccessTokenLifetime(raw) !== "ok") return { ok: false as const, error: "expired" as const };
  const { url, anon } = supabaseAuth();
  if (!url || !anon) return { ok: false as const, error: "expired" as const };
  const claimed = await claimGotrueConfirmToken(raw);
  if (!claimed) return { ok: false as const, error: "expired" as const };
  let response: Response;
  try {
    response = await fetch(`${url}/auth/v1/user`, {
      headers: { apikey: anon, Authorization: `Bearer ${raw}` },
    });
  } catch {
    await releaseGotrueConfirmToken(raw);
    return { ok: false as const, error: "expired" as const };
  }
  if (!response.ok) return { ok: false as const, error: "expired" as const };
  const body = (await response.json()) as { id?: string; email?: string; email_confirmed_at?: string | null };
  if (!body.id || !body.email_confirmed_at) return { ok: false as const, error: "expired" as const };
  const email = normalizeEmail(body.email || "") || body.email || "";
  await markConfirmed(body.id, email);
  const sessionToken = await createSession(body.id, true, meta);
  return { ok: true as const, token: sessionToken };
}

export async function confirmSupabaseTokenHash(tokenHash: string, type: "signup" | "email", meta: RequestMeta) {
  const { url, anon } = supabaseAuth();
  const hash = tokenHash.trim();
  if (!url || !anon || !hash) return { ok: false as const, error: "expired" as const };
  const response = await fetch(`${url}/auth/v1/verify`, {
    method: "POST",
    headers: { apikey: anon, "Content-Type": "application/json" },
    body: JSON.stringify(gotrueVerifyBody(type, hash)),
  });
  if (!response.ok) return { ok: false as const, error: "expired" as const };
  const user = parseGotrueUserId(await response.json().catch(() => ({})));
  if (!user) return { ok: false as const, error: "expired" as const };
  const email = normalizeEmail(user.email) || user.email;
  await markConfirmed(user.id, email);
  const sessionToken = await createSession(user.id, true, meta);
  return { ok: true as const, token: sessionToken };
}

export async function readSignupIdentity() {
  const jar = await cookies();
  const token = jar.get(SESSION_COOKIE)?.value;
  if (!token) return null;
  const row = await query<{
    user_id: string;
    email: string;
    name: string | null;
    confirmed: Date | null;
    org_id: string | null;
    partner_code: string | null;
  }>(
    `SELECT u.id::text AS user_id, lower(u.email) AS email, p.display_name AS name, u.email_confirmed_at AS confirmed,
            (SELECT m.org_id::text FROM org_members m
               JOIN organizations o ON o.id = m.org_id
              WHERE m.user_id = u.id AND m.status = 'active' AND o.environment = 'live'
              ORDER BY m.created_at LIMIT 1) AS org_id,
            d.partner_code
       FROM auth_sessions s
       JOIN auth.users u ON u.id = s.user_id
       LEFT JOIN profiles p ON p.id = u.id
       LEFT JOIN signup_drafts d ON d.user_id = u.id
      WHERE s.token_hash = $1 AND s.revoked_at IS NULL AND s.expires_at > now()`,
    [sha256(token)],
  );
  return row.rows[0] ?? null;
}

export async function createFirm(input: {
  userId: string;
  email: string;
  kind: string;
  name: string;
  contactName: string;
  phone: string;
  partnerCode: string;
  country?: string;
  phoneCountry?: string;
}) {
  const kind = input.kind === "firm" || input.kind === "self" ? input.kind : null;
  const contactName = input.contactName.trim();
  if (!kind || !contactName) return { ok: false as const, error: "required" as const };
  const firmName = firmDisplayName(kind, input.name, input.email);
  if (!firmName) return { ok: false as const, error: "required" as const };
  const code = normalizePartnerCode(input.partnerCode);
  const usableCode = code || null;
  const profile = countryByCode(input.country);
  const callingCode = input.phoneCountry?.trim() || profile.callingCode;

  const created = await withClient(async (client) => {
    await client.query("BEGIN");
    try {
      const dup = await client.query(
        `SELECT 1 FROM organizations WHERE environment = 'live' AND lower(btrim(name)) = lower(btrim($1)) LIMIT 1`,
        [firmName],
      );
      const jurisdiction = await client.query<{ id: string }>(`SELECT id::text FROM jurisdictions WHERE code = $1`, [profile.jurisdiction]);
      const inserted = await client.query<{ id: string }>(
        `INSERT INTO organizations (
           name, country_code, jurisdiction_id, default_currency, default_locale, timezone,
           is_rental_mgmt_business, plan_tier, settings, created_by,
           firm_kind, contact_name, contact_phone, contact_email, dup_name_flag, signup_source
         ) VALUES (
           $1, $2, $3, $4, $5, $6,
           $7, 'free', $8::jsonb, $9,
           $10, $11, $12, $13, $14, 'v2'
         ) RETURNING id::text`,
        [
          firmName,
          profile.code,
          jurisdiction.rows[0]?.id ?? null,
          profile.currency,
          profile.locale,
          profile.timezone,
          kind === "firm",
          JSON.stringify({ plan: { tier: "free", trialUntil: null }, signup: { source: "v2" }, country: profile.code }),
          input.userId,
          kind,
          contactName,
          normalizePhone(input.phone, callingCode) ?? (input.phone.trim() || null),
          input.email,
          Boolean(dup.rows[0]),
        ],
      );
      const orgId = inserted.rows[0].id;
      await client.query(
        `INSERT INTO org_members (org_id, user_id, role, is_billing_owner, status)
         VALUES ($1, $2, 'admin', true, 'active')`,
        [orgId, input.userId],
      );
      await client.query(`UPDATE profiles SET display_name = $2, email = $3 WHERE id = $1`, [input.userId, contactName, input.email]);
      let redeemed = null as Awaited<ReturnType<typeof redeemPartnerCode>>;
      if (usableCode) redeemed = await redeemPartnerCode(client, { orgId, code: usableCode, where: "signup" });
      await client.query(`DELETE FROM signup_drafts WHERE user_id = $1`, [input.userId]);
      const sandboxId = await seedSandboxForNewFirm(client, orgId, input.userId);
      await writeAudit(orgId, input.userId, "firm_created", {
        kind,
        name: firmName,
        dupName: Boolean(dup.rows[0]),
        code: redeemed && !redeemed.already ? redeemed.code : null,
      }, client);
      if (redeemed && !redeemed.already) {
        await writeAudit(orgId, input.userId, "code_redeemed", { code: redeemed.code, where: "signup" }, client);
      }
      await recordFunnel("firm_created", {
        userId: input.userId,
        orgId,
        email: input.email,
        detail: { kind, dupName: Boolean(dup.rows[0]) },
      }, client);
      await client.query("COMMIT");
      return { orgId, sandboxId, firmName, dupName: Boolean(dup.rows[0]), redeemed, requestedCode: input.partnerCode.trim() || null };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    }
  });

  const codeApplied = Boolean(created.redeemed && !created.redeemed.already);
  return {
    ok: true as const,
    orgId: created.orgId,
    sandboxId: created.sandboxId,
    name: created.firmName,
    dupName: created.dupName,
    codeApplied,
    codeIgnored: Boolean(created.requestedCode) && !codeApplied,
  };
}
