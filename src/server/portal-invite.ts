import { createHash, randomBytes } from "node:crypto";
import type { Client } from "pg";
import { writeAudit } from "./audit";
import { maybe, one, query, tx, withClient } from "./db";
import { FlowError, isDbTimeout } from "./errors";
import { sameId } from "@/lib/portal-page";
import { lockActive, nextFailure } from "./lockout";
import { produceNotificationEvent } from "./notification-event-producers";
import { publicSiteOrigin } from "./signup-gotrue";
import { assertStaff, type Session } from "./types";

export const PORTAL_INVITE_DAYS = 7;

const APP_HOSTS = new Set(["app.condola.app", "staging.condola.app"]);

/** Preview deploys of the staging worker. The star is the PR id. */
const PREVIEW_HOST = /^pr-[a-z0-9-]*-condola-staging\.condola\.workers\.dev$/;

/** Email guesses on one link. An office shares an IP, so that limit is higher. */
export const PORTAL_TOKEN_ATTEMPT_LIMIT = 5;
export const PORTAL_IP_ATTEMPT_LIMIT = 20;

/**
 * A contact with no free inbox still gets a link. Issuing the link does not
 * create or bind a login. The accept page asks for an email when none is stored.
 * A minted address, if an older link still has one, is never shown.
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

const MINTED_LOGIN_EMAIL = /^portal-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}@demo\.condola\.local$/;

/** Only the address provision mints. Any other stored email is a real login. */
export function mintedLoginEmail(email: string) {
  return MINTED_LOGIN_EMAIL.test(email.trim().toLowerCase());
}

/** Blank a minted address so a page cannot render it. */
export function portalInviteDisplayEmail(email: string) {
  return mintedLoginEmail(email) ? "" : email;
}

/**
 * Address the invitee will sign in with.
 * A minted login falls back to the contact email when that one is real.
 */
export function portalShownEmail(loginEmail: string | null, contactEmail: string | null) {
  const login = (loginEmail ?? "").trim();
  if (login && !mintedLoginEmail(login)) return login;
  const contact = (contactEmail ?? "").trim();
  if (contact && !mintedLoginEmail(contact)) return contact;
  return "";
}

/** Contact email to provision. Null means there is no real address, so mint one. */
export function inviteStoredEmail(contactEmail: string | null) {
  const stored = (contactEmail ?? "").trim().toLowerCase();
  if (!stored || mintedLoginEmail(stored)) return null;
  return stored;
}

/**
 * An allowed request host wins, so a PR preview copies its own host instead
 * of CONDOLA_SITE_URL. Production always copies https://app.condola.app.
 * Anything else falls back to the configured app URL. Loopback is only for
 * local tests with no site URL and no CONDOLA_ENV.
 */
export function portalInviteOrigin(requestOrigin: string) {
  const configured = httpsAppOrigin(process.env.CONDOLA_SITE_URL || "");
  const name = process.env.CONDOLA_ENV?.trim().toLowerCase();
  if (name === "production" || configured === "https://app.condola.app") return "https://app.condola.app";
  const fromRequest = allowedInviteOrigin(requestOrigin);
  if (fromRequest) return fromRequest;
  if (configured) return configured;
  if (name === "staging" || name === "staging-real") return "https://staging.condola.app";
  const loopback = loopbackOrigin(requestOrigin);
  if (loopback) return loopback;
  return publicSiteOrigin(requestOrigin);
}

function allowedInviteOrigin(value: string) {
  const first = value.split(",")[0]?.trim() ?? "";
  if (!first) return null;
  try {
    const url = new URL(first.includes("://") ? first : `https://${first}`);
    if (url.username || url.password) return null;
    if (url.protocol !== "https:" && url.protocol !== "http:") return null;
    const host = url.hostname.toLowerCase();
    if (host !== "app.condola.app" && host !== "staging.condola.app" && !PREVIEW_HOST.test(host)) return null;
    return `https://${host}`;
  } catch {
    return null;
  }
}

export function portalInviteUrl(requestOrigin: string, token: string) {
  return `${portalInviteOrigin(requestOrigin)}/accept/${encodeURIComponent(token)}`;
}

function httpsAppOrigin(value: string) {
  const raw = value.trim();
  if (!raw) return null;
  try {
    const url = new URL(raw.includes("://") ? raw : `https://${raw}`);
    if (url.protocol !== "https:") return null;
    const host = url.hostname.toLowerCase();
    if (!APP_HOSTS.has(host)) return null;
    return `https://${host}`;
  } catch {
    return null;
  }
}

function loopbackOrigin(value: string) {
  const raw = value.trim();
  if (!raw) return null;
  try {
    const url = new URL(raw.includes("://") ? raw : `http://${raw}`);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    const host = url.hostname.toLowerCase();
    if (host !== "localhost" && host !== "127.0.0.1") return null;
    return url.origin;
  } catch {
    return null;
  }
}

function attemptKey(ip: string | null) {
  const value = (ip || "unknown").trim().slice(0, 128);
  return value || "unknown";
}

/** Per-token counter. The raw token is not stored; the key is its SHA-256 hex. */
function tokenAttemptKey(token: string) {
  return `token:${hashInviteToken(token)}`;
}

async function attemptLocked(key: string) {
  const row = await query<{ locked_until: Date | null }>(
    `SELECT locked_until FROM portal_invite_attempts WHERE ip = $1`,
    [key],
  );
  return lockActive(row.rows[0]?.locked_until ?? null, new Date());
}

async function noteAttempt(key: string, limit: number) {
  const now = new Date();
  const row = await query<{ failed_count: number; locked_until: Date | null }>(
    `SELECT failed_count, locked_until FROM portal_invite_attempts WHERE ip = $1`,
    [key],
  );
  const current = row.rows[0];
  if (current && lockActive(current.locked_until, now)) return;
  const base = current && current.locked_until && !lockActive(current.locked_until, now) ? 0 : (current?.failed_count ?? 0);
  const next = nextFailure(base, now, limit);
  await query(
    `INSERT INTO portal_invite_attempts (ip, failed_count, locked_until, updated_at)
     VALUES ($1, $2, $3, now())
     ON CONFLICT (ip) DO UPDATE
       SET failed_count = EXCLUDED.failed_count, locked_until = EXCLUDED.locked_until, updated_at = now()`,
    [key, next.failedCount, next.lockedUntil],
  );
}

export async function inviteAttemptLocked(ip: string | null) {
  return attemptLocked(attemptKey(ip));
}

export async function noteBadInvite(ip: string | null) {
  await noteAttempt(attemptKey(ip), PORTAL_IP_ATTEMPT_LIMIT);
}

export async function tokenInviteLocked(token: string) {
  return attemptLocked(tokenAttemptKey(token));
}

export async function noteTokenInviteAttempt(token: string) {
  await noteAttempt(tokenAttemptKey(token), PORTAL_TOKEN_ATTEMPT_LIMIT);
}

/**
 * One accept at a time for a token. The lock lives in this transaction, so a
 * transaction pooler cannot keep it after the request. Waiters give up in 8s
 * instead of sitting on a session lock until the socket times out.
 */
export async function withInviteLock<T>(token: string, fn: () => Promise<T>): Promise<T> {
  const key = hashInviteToken(token);
  return withClient(async (client) => {
    await client.query(`BEGIN`);
    try {
      await client.query(`SET LOCAL lock_timeout = '8s'`);
      await client.query(`SET LOCAL statement_timeout = '8s'`);
      await client.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [key]);
      const result = await fn();
      await client.query(`COMMIT`);
      return result;
    } catch (error) {
      try {
        await client.query(`ROLLBACK`);
      } catch {
        // The connection is already closing.
      }
      throw error;
    }
  });
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

async function withServiceRole<T>(client: Client, fn: () => Promise<T>, restore: "authenticated" | "reset") {
  await client.query(`RESET ROLE`);
  await client.query(`SET LOCAL ROLE service_role`);
  try {
    return await fn();
  } finally {
    await client.query(restore === "authenticated" ? `SET LOCAL ROLE authenticated` : `RESET ROLE`);
  }
}

async function readPortalToken(client: Client, invitationId: string) {
  return withServiceRole(
    client,
    async () => {
      const row = await maybe<{ token: string }>(
        client,
        `SELECT token FROM portal_invite_secrets WHERE invitation_id = $1`,
        [invitationId],
      );
      return row?.token ?? null;
    },
    "authenticated",
  );
}

export async function savePortalInviteSecret(client: Client, invitationId: string, token: string) {
  await withServiceRole(
    client,
    () => client.query(`INSERT INTO portal_invite_secrets (invitation_id, token) VALUES ($1, $2)`, [invitationId, token]),
    "authenticated",
  );
}

/** Drop secrets whose invitation is no longer a live pending link. */
export async function purgePortalInviteSecrets(client: Client, restore: "authenticated" | "reset") {
  await withServiceRole(client, () => client.query(`SELECT app.purge_portal_invite_secrets()`), restore);
}

/** Drop the raw token after accept. Revoke and expiry use the invitation trigger and the purge above. */
export async function deletePortalInviteSecret(client: Client, invitationId: string) {
  await withServiceRole(
    client,
    () => client.query(`DELETE FROM portal_invite_secrets WHERE invitation_id = $1`, [invitationId]),
    "reset",
  );
}

export async function issuePortalInvite(
  session: Session,
  input: { kind: "owner" | "tenant"; contactId: string; pageId: string; leaseId?: string; rotate?: boolean },
  requestOrigin: string,
) {
  assertStaff(session, ["admin", "manager"]);
  if (!input.contactId || !input.pageId) throw new FlowError("errors.required");
  if (input.kind === "tenant" && !input.leaseId) throw new FlowError("errors.required");
  // Reject before any lock or revoke. A stale page must not touch another contact.
  if (input.kind === "owner" && !sameId(input.pageId, input.contactId)) throw new FlowError("errors.portalMismatch");
  if (input.kind === "tenant" && !sameId(input.pageId, input.leaseId || "")) throw new FlowError("errors.portalMismatch");
  const issued = await tx(
    session.userId,
    async (client) => {
      try {
        // One pending invite per contact. The lock is only for this contact.
        // A global secret purge here scanned invitations and held the lock for
        // several seconds, so the copy button waited with no feedback. Expired
        // secrets for this contact are removed when its pending row is revoked.
        // Opening a link still runs the purge.
        await client.query(`SET LOCAL lock_timeout = '1s'`);
        await client.query(`SET LOCAL statement_timeout = '2s'`);
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
        if (!sameId(contact.id, input.contactId)) throw new FlowError("errors.portalMismatch");
        if (input.kind === "owner" && (!contact.is_owner || !sameId(contact.id, input.pageId))) {
          throw new FlowError("errors.portalMismatch");
        }
        if (input.kind === "tenant" && !contact.is_tenant) throw new FlowError("errors.notFound");
        if (input.kind === "tenant") {
          const party = await maybe<{ id: string }>(
            client,
            `SELECT lease_id::text AS id
               FROM lease_parties
              WHERE org_id = $1 AND lease_id = $2 AND contact_id = $3 AND role = 'primary'`,
            [session.orgId, input.leaseId, contact.id],
          );
          if (!party) throw new FlowError("errors.portalMismatch");
        }
        const login = contact.user_id ? await readLogin(client, contact.user_id) : null;
        const contactEmail = inviteStoredEmail(contact.email);
        const loginEmail = login?.email && !mintedLoginEmail(login.email) ? login.email : null;
        const shown = portalShownEmail(contactEmail, loginEmail);
        const pending = await maybe<{ id: string; email: string | null; kind: string; lease_id: string | null }>(
          client,
          `SELECT id::text, email::text AS email, kind::text, lease_id::text AS lease_id
             FROM invitations
            WHERE org_id = $1 AND contact_id = $2 AND status = 'pending'
              AND kind IN ('owner', 'tenant') AND expires_at > now()
            FOR UPDATE`,
          [session.orgId, contact.id],
        );
        // A ready login with no live invite has already accepted. A pending invite,
        // including one stored before the secret table existed, can still be copied.
        if (login?.ready && !pending) return { activated: true as const, contactId: contact.id };
        if (!input.rotate && pending) {
          const sameLease = input.kind === "owner" || sameId(pending.lease_id || "", input.leaseId || "");
          if (pending.kind !== input.kind || !sameLease) throw new FlowError("errors.portalRenew");
          const token = await readPortalToken(client, pending.id);
          if (token) {
            return {
              activated: false as const,
              reused: true as const,
              token,
              email: portalShownEmail(pending.email, contact.email),
              name: contact.display_name,
              invitationId: pending.id,
              contactId: contact.id,
            };
          }
        }
        await withServiceRole(
          client,
          () =>
            client.query(
              `UPDATE invitations
                  SET status = 'revoked'
                WHERE org_id = $1 AND contact_id = $2 AND status = 'pending' AND kind IN ('owner', 'tenant')`,
              [session.orgId, contact.id],
            ),
          "authenticated",
        );
        const token = newInviteToken();
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
            contactEmail ?? loginEmail,
            contact.phone_e164,
            hashInviteToken(token),
            PORTAL_INVITE_DAYS,
            session.userId,
          ],
        );
        await savePortalInviteSecret(client, row.id, token);
        await produceNotificationEvent(client, session.orgId, "invitation", row.id);
        return {
          activated: false as const,
          reused: false as const,
          token,
          email: shown,
          name: contact.display_name,
          invitationId: row.id,
          contactId: contact.id,
        };
      } catch (error) {
        if (error instanceof FlowError) throw error;
        if (isDbTimeout(error)) throw new FlowError("errors.portalTimeout");
        throw error;
      }
    },
    { orgId: session.orgId, environment: session.environment },
  );
  if (issued.activated) return { activated: true as const, contactId: issued.contactId };
  if (!issued.reused) {
    await writeAudit(session.orgId, session.userId, "portal_invite", {
      kind: input.kind,
      contactId: issued.contactId,
      invitationId: issued.invitationId,
      ...(input.leaseId ? { leaseId: input.leaseId } : {}),
    });
  }
  return {
    activated: false as const,
    email: issued.email,
    name: issued.name,
    url: portalInviteUrl(requestOrigin, issued.token),
    token: issued.token,
    contactId: issued.contactId,
  };
}
