import { createHash, randomBytes } from "node:crypto";
import { cookies } from "next/headers";
import { writeAudit } from "./audit";
import { createSession, normalizeEmail, SESSION_COOKIE, type RequestMeta } from "./auth";
import { firmDisplayName, normalizePartnerCode } from "./billing";
import { query, withClient } from "./db";
import { recordFunnel } from "./funnel";
import { previewPartnerCode, redeemPartnerCode } from "./partners";
import { normalizePhone } from "./lease-rules";
import { passwordAcceptable } from "./password";
import { seedSandboxForNewFirm } from "./sandbox";
import { gotrueEndpoint, gotrueVerifyBody, parseGotrueUserId, parseSupabaseSignup, signupConfirmUrl } from "./signup-gotrue";

const VERIFY_HOURS = 24;

export type SignupError = "duplicate" | "weak" | "mismatch" | "email" | "required";

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

async function spendPasswordTime(password: string) {
  await query(`SELECT crypt($1, gen_salt('bf'))`, [password]);
}

type ExistingUser = { id: string; email_confirmed_at: Date | null; has_firm: boolean; encrypted_password: string | null };

async function findUser(email: string) {
  const row = await query<ExistingUser>(
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

async function passwordMatches(userId: string, password: string) {
  const row = await query<{ ok: boolean }>(
    `SELECT encrypted_password IS NOT NULL AND encrypted_password = crypt($2, encrypted_password) AS ok
       FROM auth.users WHERE id = $1`,
    [userId, password],
  );
  return Boolean(row.rows[0]?.ok);
}

async function rememberDraft(userId: string, partnerCode: string | null) {
  await query(
    `INSERT INTO signup_drafts (user_id, partner_code) VALUES ($1, $2)
     ON CONFLICT (user_id) DO UPDATE SET partner_code = EXCLUDED.partner_code`,
    [userId, partnerCode],
  );
}

async function issueVerification(userId: string, email: string) {
  const token = newToken();
  await query(
    `UPDATE signup_verifications SET used_at = now() WHERE user_id = $1 AND used_at IS NULL`,
    [userId],
  );
  await query(
    `INSERT INTO signup_verifications (user_id, email, token_hash, expires_at)
     VALUES ($1, $2, $3, now() + make_interval(hours => $4))`,
    [userId, email, sha256(token), VERIFY_HOURS],
  );
  return token;
}

async function supabaseSignUp(email: string, password: string, requestOrigin: string) {
  const { url, anon } = supabaseAuth();
  if (!url || !anon) return null;
  const redirectTo = signupConfirmUrl(requestOrigin);
  const response = await fetch(gotrueEndpoint(url, "/auth/v1/signup", redirectTo), {
    method: "POST",
    headers: { apikey: anon, "Content-Type": "application/json" },
    body: JSON.stringify({ email, password }),
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

/** Profile and the first funnel row. Safe to call again for an unconfirmed account. */
async function ensureSignupStarted(userId: string, email: string) {
  await query(
    `INSERT INTO profiles (id, display_name, email, locale)
     VALUES ($1, $2, $3, 'zh-TW')
     ON CONFLICT (id) DO UPDATE SET email = EXCLUDED.email`,
    [userId, email.split("@")[0], email],
  );
  await query(
    `INSERT INTO funnel_events (event_type, user_id, email, detail)
     SELECT 'signup_started', $1::uuid, $2, '{}'::jsonb
      WHERE NOT EXISTS (
        SELECT 1 FROM funnel_events WHERE event_type = 'signup_started' AND user_id = $1::uuid
      )`,
    [userId, email],
  );
}

async function markConfirmed(userId: string, email: string) {
  const updated = await query(
    `UPDATE auth.users SET email_confirmed_at = now(), updated_at = now()
      WHERE id = $1 AND email_confirmed_at IS NULL`,
    [userId],
  );
  if (updated.rowCount === 1) {
    await recordFunnel("email_confirmed", { userId, email });
    await writeAudit(null, userId, "email_confirmed", { email });
    return;
  }
  const prior = await query(`SELECT 1 FROM funnel_events WHERE event_type = 'email_confirmed' AND user_id = $1 LIMIT 1`, [userId]);
  if (!prior.rows[0]) await recordFunnel("email_confirmed", { userId, email });
}

async function storeCode(raw: string) {
  const code = normalizePartnerCode(raw);
  if (!code) return null;
  const preview = await previewPartnerCode(code);
  return preview.state === "valid" ? preview.code : null;
}

export async function startSignup(input: {
  email: string;
  password: string;
  confirm: string;
  partnerCode: string;
  origin: string;
  meta: RequestMeta;
}): Promise<
  | { ok: true; status: "verify"; email: string; devToken: string | null }
  | { ok: true; status: "firm"; token: string }
  | { ok: false; error: SignupError }
> {
  const email = normalizeEmail(input.email);
  if (!email) {
    await spendPasswordTime(input.password || "placeholder");
    return { ok: false, error: "email" };
  }
  if (input.password !== input.confirm) {
    await spendPasswordTime(input.password || "placeholder");
    return { ok: false, error: "mismatch" };
  }
  if (!passwordAcceptable(input.password)) {
    await spendPasswordTime(input.password);
    return { ok: false, error: "weak" };
  }
  await spendPasswordTime(input.password);
  const existing = await findUser(email);
  const draftCode = await storeCode(input.partnerCode);

  if (existing) {
    const matches = await passwordMatches(existing.id, input.password);
    if (existing.has_firm || existing.email_confirmed_at) {
      if (existing.email_confirmed_at && matches && !existing.has_firm) {
        await rememberDraft(existing.id, draftCode);
        const token = await createSession(existing.id, true, input.meta);
        return { ok: true, status: "firm", token };
      }
      return { ok: false, error: "duplicate" };
    }
    // Leave auth.users alone. An admin password update clears confirmation_token and
    // confirmation_sent_at, which expires the link already in the inbox, and this path does not send a new email.
    await rememberDraft(existing.id, draftCode);
    await ensureSignupStarted(existing.id, email);
    const token = await issueVerification(existing.id, email);
    return { ok: true, status: "verify", email, devToken: signupLinksExposed() ? token : null };
  }

  const remote = await supabaseSignUp(email, input.password, input.origin);
  if (remote === "duplicate") return { ok: false, error: "duplicate" };
  if (remote === "unavailable") return { ok: false, error: "required" };
  let userId = remote?.id ?? "";
  const confirmed = remote?.confirmed ?? false;
  if (!remote) {
    try {
      const inserted = await query<{ id: string }>(
        `INSERT INTO auth.users (id, email, encrypted_password, raw_user_meta_data, role, aud)
         VALUES (gen_random_uuid(), $1, crypt($2, gen_salt('bf')), '{}'::jsonb, 'authenticated', 'authenticated')
         RETURNING id::text`,
        [email, input.password],
      );
      userId = inserted.rows[0].id;
    } catch (error) {
      const code = typeof error === "object" && error && "code" in error ? String((error as { code: unknown }).code) : "";
      if (code === "23505") return { ok: false, error: "duplicate" };
      throw error;
    }
  }
  await ensureSignupStarted(userId, email);
  await rememberDraft(userId, draftCode);
  if (confirmed) {
    await markConfirmed(userId, email);
    const token = await createSession(userId, true, input.meta);
    return { ok: true, status: "firm", token };
  }
  const token = await issueVerification(userId, email);
  return { ok: true, status: "verify", email, devToken: signupLinksExposed() ? token : null };
}

export async function resendSignup(emailRaw: string, origin: string) {
  const email = normalizeEmail(emailRaw);
  if (!email) return { devToken: null as string | null };
  const existing = await findUser(email);
  if (!existing || existing.email_confirmed_at || existing.has_firm) return { devToken: null as string | null };
  const token = await issueVerification(existing.id, email);
  await supabaseResend(email, origin);
  return { devToken: signupLinksExposed() ? token : null };
}

export async function changeSignupEmail(input: { currentEmail: string; password: string; nextEmail: string; origin: string }) {
  const current = normalizeEmail(input.currentEmail);
  const next = normalizeEmail(input.nextEmail);
  if (!current || !next) return { ok: false as const, error: "email" as const };
  await spendPasswordTime(input.password);
  const existing = await findUser(current);
  if (!existing || existing.email_confirmed_at || existing.has_firm) return { ok: false as const, error: "duplicate" as const };
  if (!(await passwordMatches(existing.id, input.password))) return { ok: false as const, error: "duplicate" as const };
  const taken = await findUser(next);
  if (taken && taken.id !== existing.id) return { ok: false as const, error: "duplicate" as const };
  const { url, service } = supabaseAuth();
  if (url && service) {
    const response = await fetch(`${url}/auth/v1/admin/users/${existing.id}`, {
      method: "PUT",
      headers: { apikey: service, Authorization: `Bearer ${service}`, "Content-Type": "application/json" },
      body: JSON.stringify({ email: next, email_confirm: false }),
    });
    if (!response.ok) return { ok: false as const, error: "required" as const };
  } else {
    await query(`UPDATE auth.users SET email = $2, email_confirmed_at = NULL, updated_at = now() WHERE id = $1`, [existing.id, next]);
  }
  await query(`UPDATE profiles SET email = $2 WHERE id = $1`, [existing.id, next]);
  const token = await issueVerification(existing.id, next);
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

export async function confirmSupabaseAccessToken(accessToken: string, meta: RequestMeta) {
  const { url, anon } = supabaseAuth();
  if (!url || !anon || !accessToken.trim()) return { ok: false as const, error: "expired" as const };
  const response = await fetch(`${url}/auth/v1/user`, {
    headers: { apikey: anon, Authorization: `Bearer ${accessToken.trim()}` },
  });
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
}) {
  const kind = input.kind === "firm" || input.kind === "self" ? input.kind : null;
  const contactName = input.contactName.trim();
  if (!kind || !contactName) return { ok: false as const, error: "required" as const };
  const firmName = firmDisplayName(kind, input.name, input.email);
  if (!firmName) return { ok: false as const, error: "required" as const };
  const code = normalizePartnerCode(input.partnerCode);
  const usableCode = code || null;

  const created = await withClient(async (client) => {
    await client.query("BEGIN");
    try {
      const dup = await client.query(
        `SELECT 1 FROM organizations WHERE environment = 'live' AND lower(btrim(name)) = lower(btrim($1)) LIMIT 1`,
        [firmName],
      );
      const jurisdiction = await client.query<{ id: string }>(`SELECT id::text FROM jurisdictions WHERE code = 'TW'`);
      const inserted = await client.query<{ id: string }>(
        `INSERT INTO organizations (
           name, country_code, jurisdiction_id, default_currency, default_locale, timezone,
           is_rental_mgmt_business, plan_tier, settings, created_by,
           firm_kind, contact_name, contact_phone, contact_email, dup_name_flag, signup_source
         ) VALUES (
           $1, 'TW', $2, 'TWD', 'zh-TW', 'Asia/Taipei',
           $3, 'free', $4::jsonb, $5,
           $6, $7, $8, $9, $10, 'v2'
         ) RETURNING id::text`,
        [
          firmName,
          jurisdiction.rows[0]?.id ?? null,
          kind === "firm",
          JSON.stringify({ plan: { tier: "free", trialUntil: null }, signup: { source: "v2" } }),
          input.userId,
          kind,
          contactName,
          normalizePhone(input.phone) ?? (input.phone.trim() || null),
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
      await client.query("COMMIT");
      return { orgId, sandboxId, firmName, dupName: Boolean(dup.rows[0]), redeemed, requestedCode: input.partnerCode.trim() || null };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    }
  });

  await writeAudit(created.orgId, input.userId, "firm_created", {
    kind,
    name: created.firmName,
    dupName: created.dupName,
    code: created.redeemed && !created.redeemed.already ? created.redeemed.code : null,
  });
  if (created.redeemed && !created.redeemed.already) {
    await writeAudit(created.orgId, input.userId, "code_redeemed", { code: created.redeemed.code, where: "signup" });
  }
  await recordFunnel("firm_created", {
    userId: input.userId,
    orgId: created.orgId,
    email: input.email,
    detail: { kind, dupName: created.dupName },
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
