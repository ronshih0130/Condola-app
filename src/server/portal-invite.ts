import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { Client } from "pg";
import { writeAudit } from "./audit";
import { maybe, one, query, tx } from "./db";
import { FlowError } from "./errors";
import { lockActive, nextFailure } from "./lockout";
import { authEmailTaken, portalLoginEmail } from "./portal-login";
import { publicSiteOrigin } from "./signup-gotrue";
import { assertStaff, type Session } from "./types";

export const PORTAL_INVITE_DAYS = 7;

const DIRECT_HOSTS = new Set([
  "app.condola.app",
  "staging.condola.app",
  "condola-staging.condola.workers.dev",
]);

/**
 * A minted portal-<uuid>@demo.condola.local login still gets a link.
 * The manager hands the link over themselves, and the set-password page
 * shows that login email. Refusing until a real inbox exists would leave
 * the contact unable to sign in. An email that already belongs to another
 * login is never attached; provision mints a new address instead.
 */
export const MINTED_LOGIN_HOST = "demo.condola.local";

export function newInviteToken() {
  return randomBytes(32).toString("base64url");
}

export function inviteTokenBytes(token: string) {
  return Buffer.from(token, "base64url").length;
}

export function hashInviteToken(token: string) {
  return createHash("sha256").update(token).digest("hex");
}

export function mintedLoginEmail(email: string) {
  return email.trim().toLowerCase().endsWith(`@${MINTED_LOGIN_HOST}`);
}

/** Request host when it is this app. Anything else uses the site URL config. */
export function portalInviteOrigin(requestOrigin: string) {
  const direct = directAppOrigin(requestOrigin);
  if (direct) return direct;
  return publicSiteOrigin(requestOrigin);
}

export function portalInviteUrl(requestOrigin: string, token: string) {
  return `${portalInviteOrigin(requestOrigin)}/accept/${encodeURIComponent(token)}`;
}

function directAppOrigin(value: string) {
  const raw = value.trim();
  if (!raw) return null;
  try {
    const url = new URL(raw.includes("://") ? raw : `https://${raw}`);
    const host = url.hostname.toLowerCase();
    if (host === "localhost" || host === "127.0.0.1") {
      if (url.protocol !== "http:" && url.protocol !== "https:") return null;
      return url.origin;
    }
    if (url.protocol !== "https:" || !DIRECT_HOSTS.has(host)) return null;
    return `https://${host}`;
  } catch {
    return null;
  }
}

function attemptKey(ip: string | null) {
  const value = (ip || "unknown").trim().slice(0, 128);
  return value || "unknown";
}

export async function inviteAttemptLocked(ip: string | null) {
  const row = await query<{ locked_until: Date | null }>(
    `SELECT locked_until FROM portal_invite_attempts WHERE ip = $1`,
    [attemptKey(ip)],
  );
  return lockActive(row.rows[0]?.locked_until ?? null, new Date());
}

export async function noteBadInvite(ip: string | null) {
  const key = attemptKey(ip);
  const now = new Date();
  const row = await query<{ failed_count: number; locked_until: Date | null }>(
    `SELECT failed_count, locked_until FROM portal_invite_attempts WHERE ip = $1`,
    [key],
  );
  const current = row.rows[0];
  if (current && lockActive(current.locked_until, now)) return;
  const base = current && current.locked_until && !lockActive(current.locked_until, now) ? 0 : (current?.failed_count ?? 0);
  const next = nextFailure(base, now);
  await query(
    `INSERT INTO portal_invite_attempts (ip, failed_count, locked_until, updated_at)
     VALUES ($1, $2, $3, now())
     ON CONFLICT (ip) DO UPDATE
       SET failed_count = EXCLUDED.failed_count, locked_until = EXCLUDED.locked_until, updated_at = now()`,
    [key, next.failedCount, next.lockedUntil],
  );
}

export async function portalLoginReady(userId: string | null) {
  if (!userId) return false;
  const row = await query<{ ready: boolean }>(
    `SELECT (encrypted_password IS NOT NULL AND btrim(encrypted_password) <> '') AS ready
       FROM auth.users WHERE id = $1`,
    [userId],
  );
  return row.rows[0]?.ready === true;
}

type ContactLogin = {
  id: string;
  user_id: string | null;
  display_name: string;
  email: string | null;
  phone_e164: string | null;
  is_owner: boolean;
  is_tenant: boolean;
};

async function readLogin(client: Client, userId: string) {
  await client.query(`RESET ROLE`);
  try {
    return await one<{ email: string; ready: boolean }>(
      client,
      `SELECT email::text AS email,
              (encrypted_password IS NOT NULL AND btrim(encrypted_password) <> '') AS ready
         FROM auth.users WHERE id = $1`,
      [userId],
    );
  } finally {
    await client.query(`SET LOCAL ROLE authenticated`);
  }
}

async function provisionLogin(client: Client, input: { name: string; email: string; phone: string | null }) {
  await client.query(`SAVEPOINT portal_invite_login`);
  try {
    await client.query(`SET LOCAL ROLE service_role`);
    const user = await one<{ id: string }>(
      client,
      `SELECT app.provision_portal_user($1, $2, $3) AS id`,
      [input.email, input.name, input.phone],
    );
    await client.query(`RELEASE SAVEPOINT portal_invite_login`);
    await client.query(`SET LOCAL ROLE authenticated`);
    return user.id;
  } catch (error) {
    await client.query(`ROLLBACK TO SAVEPOINT portal_invite_login`);
    await client.query(`SET LOCAL ROLE authenticated`);
    throw error;
  }
}

async function attachLogin(client: Client, session: Session, contact: ContactLogin) {
  if (contact.user_id) return readLogin(client, contact.user_id).then((login) => ({ id: contact.user_id as string, ...login }));
  const preferred = portalLoginEmail({
    environment: session.environment,
    contactEmail: contact.email,
    emailTaken: false,
  });
  const minted = `portal-${randomUUID()}@${MINTED_LOGIN_HOST}`;
  const first = preferred ?? minted;
  const attempt = async (email: string) => {
    const id = await provisionLogin(client, { name: contact.display_name, email, phone: contact.phone_e164 });
    const updated = await client.query(
      `UPDATE contacts SET user_id = $2, updated_at = now()
        WHERE id = $1 AND org_id = $3 AND user_id IS NULL`,
      [contact.id, id, session.orgId],
    );
    if (updated.rowCount === 1) return { id, email, ready: false };
    const again = await one<{ user_id: string }>(
      client,
      `SELECT user_id::text AS user_id FROM contacts WHERE id = $1 AND org_id = $2 AND user_id IS NOT NULL`,
      [contact.id, session.orgId],
    );
    const login = await readLogin(client, again.user_id);
    return { id: again.user_id, email: login.email, ready: login.ready };
  };
  try {
    return await attempt(first);
  } catch (error) {
    if (!preferred || !authEmailTaken(error)) throw error;
    return attempt(minted);
  }
}

export async function issuePortalInvite(
  session: Session,
  input: { kind: "owner" | "tenant"; contactId: string; leaseId?: string },
  requestOrigin: string,
) {
  assertStaff(session, ["admin", "manager"]);
  if (input.kind === "tenant" && !input.leaseId) throw new FlowError("errors.required");
  const issued = await tx(
    session.userId,
    async (client) => {
      await client.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [`portal-invite:${input.contactId}`]);
      const contact = await maybe<ContactLogin>(
        client,
        `SELECT id::text, user_id::text AS user_id, display_name, email::text AS email, phone_e164,
                is_owner, is_tenant
           FROM contacts
          WHERE id = $1 AND org_id = $2 AND archived_at IS NULL
          FOR UPDATE`,
        [input.contactId, session.orgId],
      );
      if (!contact) throw new FlowError("errors.notFound");
      if (input.kind === "owner" && !contact.is_owner) throw new FlowError("errors.notFound");
      if (input.kind === "tenant" && !contact.is_tenant) throw new FlowError("errors.notFound");
      if (input.kind === "tenant") {
        const party = await maybe<{ id: string }>(
          client,
          `SELECT lease_id::text AS id
             FROM lease_parties
            WHERE org_id = $1 AND lease_id = $2 AND contact_id = $3 AND role = 'primary'`,
          [session.orgId, input.leaseId, contact.id],
        );
        if (!party) throw new FlowError("errors.notFound");
      }
      const login = await attachLogin(client, session, contact);
      if (login.ready) return { activated: true as const };
      const token = newInviteToken();
      await client.query(
        `UPDATE invitations
            SET status = 'revoked'
          WHERE org_id = $1 AND contact_id = $2 AND status = 'pending' AND kind IN ('owner', 'tenant')`,
        [session.orgId, contact.id],
      );
      const row = await one<{ id: string }>(
        client,
        `INSERT INTO invitations (
           org_id, kind, contact_id, lease_id, email, phone_e164, code_hash, status, expires_at, invited_by
         ) VALUES (
           $1, $2::invitation_kind, $3, $4, $5, $6, $7, 'pending', now() + make_interval(days => $8), $9
         ) RETURNING id::text`,
        [
          session.orgId,
          input.kind,
          contact.id,
          input.kind === "tenant" ? input.leaseId : null,
          login.email,
          contact.phone_e164,
          hashInviteToken(token),
          PORTAL_INVITE_DAYS,
          session.userId,
        ],
      );
      return {
        activated: false as const,
        token,
        email: login.email,
        invitationId: row.id,
        contactId: contact.id,
      };
    },
    { orgId: session.orgId, environment: session.environment },
  );
  if (issued.activated) return { activated: true as const };
  await writeAudit(session.orgId, session.userId, "portal_invite", {
    kind: input.kind,
    contactId: issued.contactId,
    invitationId: issued.invitationId,
    ...(input.leaseId ? { leaseId: input.leaseId } : {}),
  });
  return {
    activated: false as const,
    email: issued.email,
    url: portalInviteUrl(requestOrigin, issued.token),
    token: issued.token,
  };
}
