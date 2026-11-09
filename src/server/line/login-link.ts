import { finishVendorFlowOn, vendorScopeOn } from "./vendor-scope";
import { hashVendorToken, vendorTokenAcceptable } from "../vendor-repair-rules";
import { randomBytes } from "node:crypto";
import type { Client } from "pg";
import { withClient } from "../db";
import { requireEffectivePerm } from "../b017-custom-role-governance";
import { FlowError } from "../errors";
import { createSessionOn, normalizeEmail, provisionAcceptedLogin, type RequestMeta } from "../auth";
import { consentCoversCurrent, type StoredConsent } from "../consent";
import { hashInviteToken, mintedLoginEmail, portalShownEmail } from "../portal-invite";
import { lockActive } from "../lockout";
import { passwordAcceptable } from "../password";
import { verifyTotp } from "../totp";
import { readLineConfig } from "./config";
import { providerUserHash, type SecretResolver } from "./webhook";
import { equalHash, lineHash, LineError, rejectLine, returnPath, type LinePersona, verifyLoginToken } from "./login-token";

export const randomProof = () => randomBytes(32).toString("base64url");
export type BrowserProof = { browser: string; csrf: string };
export type LineFlow = {
 id: string; flow_hash: string; kind: "login" | "invite" | "bind" | "unlink"; persona: LinePersona;
 org_id: string; contact_id: string | null; invitation_id: string | null; invitation_hash: string | null;
 user_id: string | null; line_channel_id: string; browser_hash: string; csrf_hash: string;
 state_hash: string; nonce_hash: string; pkce_hash: string | null; oauth_started_at: Date | null;
 expires_at: Date; consumed_at: Date | null; verified_hash: string | null; attempts: number; return_path: string;
};
type Channel = { id: string; login_channel_id: string; login_channel_secret_ref: string; line_provider_id: string; liff_id: string; tenant_config_verified_at: Date | null };
type Invite = { id: string; org_id: string; contact_id: string; kind: LinePersona; code_hash: string;
 status: string; expires_at: Date; email: string | null; lease_id: string | null };
type Account = { id: string; email: string; email_confirmed_at: Date | null; has_password: boolean; matches: boolean };
export type AuthInput = { email?: string; password?: string; secondFactor?: string; sessionToken?: string };

/** Uses the existing local DB auth/provisioning helpers. No GoTrue or provider calls. */
export async function lineTransaction<T>(fn: (c: Client) => Promise<T>): Promise<T> {
 return withClient(async c => {
  try {
   await c.query("BEGIN");
   await c.query("SET LOCAL statement_timeout='8s'");
   await c.query("SET LOCAL lock_timeout='3s'");
   const result = await fn(c);
   await c.query("COMMIT"); return result;
  } catch (error) {
   await c.query("ROLLBACK");
   if (error instanceof LineError) throw error;
   const db = error as { code?: string; message?: string };
   if (db.code === "P0033" && ["not_found", "identity_conflict", "already_consumed", "consent_required"].includes(db.message ?? "")) {
    throw new LineError(db.message === "not_found" ? 404 : db.message === "consent_required" ? 403 : 409, db.message!);
   }
   if (db.code === "23505" || db.code === "23514") throw new LineError(409, "identity_conflict");
   throw new LineError(503, "line_unavailable");
  }
 });
}
export async function channelOn(c: Client, orgId: string, persona: LinePersona): Promise<Channel> {
 if (!readLineConfig().platformEnabled) rejectLine(404, "not_found");
 const row = (await c.query<Channel>(`SELECT ch.id,ch.login_channel_id,ch.login_channel_secret_ref,ch.line_provider_id,ch.tenant_config_verified_at,
  CASE $2 WHEN 'tenant' THEN ch.liff_id_tenant WHEN 'owner' THEN ch.liff_id_owner WHEN 'vendor' THEN ch.liff_id_vendor END AS liff_id
  FROM line_channels ch WHERE app.b033_portal_enabled($1,$2) AND ch.id=app.b033_selected_channel($1) FOR SHARE OF ch`, [orgId, persona])).rows[0];
 if (!row) rejectLine(404, "not_found");
 if (!row.tenant_config_verified_at || !row.login_channel_id || !row.login_channel_secret_ref) rejectLine(503, "line_unavailable");
 return row;
}
export async function sessionOn(c: Client, token?: string, recent = false) {
 if (!token) return null;
 const row = (await c.query<{ id: string; user_id: string }>(`SELECT s.id,s.user_id FROM auth_sessions s
  JOIN auth.users u ON u.id=s.user_id WHERE s.token_hash=$1 AND s.revoked_at IS NULL AND s.expires_at>clock_timestamp()
  AND u.email_confirmed_at IS NOT NULL AND (NOT $2 OR EXISTS (
   SELECT 1 FROM app.b033_line_stepups r LEFT JOIN user_mfa m ON m.user_id=u.id
   WHERE r.session_id=s.id AND r.authenticated_at>clock_timestamp()-interval '10 minutes'
    AND r.authenticated_at<=clock_timestamp()
    AND r.credential_hash=encode(digest(u.encrypted_password||coalesce(m.totp_secret,'')||coalesce(m.enabled,false)::text,'sha256'),'hex')
    AND (r.mfa_verified OR (NOT coalesce(m.enabled,false) AND NOT EXISTS (
     SELECT 1 FROM org_members om JOIN organizations o ON o.id=om.org_id
     WHERE om.user_id=u.id AND om.status='active' AND o.settings->>'require_2fa'='true')))
  )) FOR SHARE OF s`, [lineHash(token), recent])).rows[0];
 return row ?? null;
}
async function inviteOn(c: Client, id: string, hash: string): Promise<Invite> {
 const i = (await c.query<Invite>("SELECT * FROM invitations WHERE id=$1 AND code_hash=$2 FOR UPDATE", [id, hash])).rows[0];
 if (!i || !["tenant", "owner"].includes(i.kind) || i.status === "revoked") rejectLine(404, "not_found");
 if (i.status === "accepted") rejectLine(409, "already_consumed");
 if (i.status !== "pending" || i.expires_at.getTime() <= Date.now()) rejectLine(410, "invite_expired");
 const attempt = (await c.query("SELECT locked_until FROM portal_invite_attempts WHERE ip=$1", [`token:${hash}`])).rows[0];
 if (lockActive(attempt?.locked_until ?? null, new Date())) rejectLine(429, "rate_limited");
 return i;
}
export async function flowOn(c: Client, handle: string, proof: BrowserProof, lock = false): Promise<LineFlow> {
 const f = (await c.query<LineFlow>(`SELECT * FROM app.b033_line_flows WHERE flow_hash=$1${lock ? " FOR UPDATE" : ""}`, [lineHash(handle)])).rows[0];
 if (!f || !f.org_id || !equalHash(proof.browser, f.browser_hash) || !equalHash(proof.csrf, f.csrf_hash)) rejectLine(404, "not_found");
 const ch = await channelOn(c, f.org_id, f.persona);
 if (ch.id !== f.line_channel_id) rejectLine(404, "not_found");
 if (f.consumed_at) rejectLine(409, "already_consumed");
 if (f.expires_at.getTime() <= Date.now()) rejectLine(410, "flow_expired");
 if (f.attempts > 5) rejectLine(429, "rate_limited");
 return f;
}
/** Durable admission is separate from the business transaction, so failed credentials cannot reset the budget.
 * Gating is checked before admission writes. All callers hold the platform/org gate until commit. */
export async function admit(c: Client, scope: string, limit = 30) {
 const r = await c.query(`INSERT INTO app.b033_line_limits(key_hash,attempts,reset_at)
  VALUES($1,1,now()+interval '15 minutes') ON CONFLICT(key_hash) DO UPDATE
  SET attempts=CASE WHEN b033_line_limits.reset_at<=now() THEN 1 ELSE b033_line_limits.attempts+1 END,
   reset_at=CASE WHEN b033_line_limits.reset_at<=now() THEN now()+interval '15 minutes' ELSE b033_line_limits.reset_at END
  WHERE b033_line_limits.reset_at<=now() OR b033_line_limits.attempts<$2 RETURNING attempts`, [lineHash(scope), limit]);
 if (!r.rows[0]) rejectLine(429, "rate_limited");
}
export async function createLineFlow(input: { purpose: LineFlow["kind"]; inviteToken?: string; orgId?: string; contactId?: string;
 persona?: LinePersona; returnPath?: string; sessionToken?: string; jobToken?: string }, proof: BrowserProof) {
 return lineTransaction(async c => {
  if (!readLineConfig().platformEnabled) rejectLine(404, "not_found");
  let org = input.orgId, contact = input.contactId ?? null, persona = input.persona, invitation: Invite | undefined;
  let job: Awaited<ReturnType<typeof vendorScopeOn>> | undefined;
  if (input.jobToken !== undefined) {
   if (input.purpose !== "login" || input.persona !== "vendor" || !vendorTokenAcceptable(input.jobToken)
    || input.contactId || input.inviteToken || input.returnPath) rejectLine(404, "not_found");
   // Resolve only the org before gating; invalid/foreign hints never reveal channel health.
   const pinned = (await c.query("SELECT org_id FROM repair_vendor_jobs WHERE token_hash=$1", [hashVendorToken(input.jobToken)])).rows[0];
   if (!pinned || org && org !== pinned.org_id) rejectLine(404, "not_found");
   org = pinned.org_id;
   await channelOn(c, org!, "vendor");
   job = await vendorScopeOn(c, hashVendorToken(input.jobToken), org);
  }
  if (input.purpose === "invite") {
   const hash = hashInviteToken(input.inviteToken ?? "");
   invitation = (await c.query<Invite>("SELECT * FROM invitations WHERE code_hash=$1", [hash])).rows[0];
   if (!invitation || !["tenant", "owner"].includes(invitation.kind)) rejectLine(404, "not_found");
   org = invitation.org_id; contact = invitation.contact_id; persona = invitation.kind;
  }
  if (!org || !persona) rejectLine(404, "not_found");
  const ch = await channelOn(c, org, persona);
  if (invitation) await inviteOn(c, invitation.id, invitation.code_hash);
  let user: string | null = null;
  if (input.purpose === "bind" || input.purpose === "unlink") {
   const session = await sessionOn(c, input.sessionToken, true);
   if (!session) rejectLine(401, "reauth_required");
   user = session.user_id;
   if (!contact || (await c.query("SELECT app.b033_contact_user($1,$2,$3) AS id", [org, contact, persona])).rows[0].id !== user) rejectLine(404, "not_found");
  }
  // A login hint carries no authority over a contact. The verified identity selects owned links later.
  if (input.purpose === "login") contact = null;
  const next = returnPath(persona, input.returnPath);
  await admit(c, `create-org:${org}`, 100);
  await admit(c, `create:${org}:${proof.browser}`, 20);
  const flow = randomProof();
  const result = await c.query<{ id: string; expires_at: Date }>(`INSERT INTO app.b033_line_flows(flow_hash,kind,line_channel_id,persona,
   state_hash,nonce_hash,expires_at,org_id,contact_id,invitation_id,invitation_hash,user_id,browser_hash,csrf_hash,return_path)
   VALUES($1,$2,$3,$4,$5,$6,now()+interval '5 minutes',$7,$8,$9,$10,$11,$12,$13,$14) RETURNING id,expires_at`,
   [lineHash(flow), input.purpose, ch.id, persona, lineHash(randomProof()), lineHash(randomProof()), org, contact,
    invitation?.id ?? null, invitation?.code_hash ?? null, user, lineHash(proof.browser), lineHash(proof.csrf), next]);
  if (job) await c.query("INSERT INTO app.b035_vendor_flows(flow_id,job_id,token_hash) VALUES($1,$2,$3)",
   [result.rows[0].id, job.job_id, hashVendorToken(input.jobToken!)]);
  return { flow, expiresAt: result.rows[0].expires_at.toISOString(), persona, liffId: ch.liff_id };
 });
}
export async function admitFlow(handle: string, proof: BrowserProof) {
 return lineTransaction(async c => {
  const f = await flowOn(c, handle, proof, true);
  if (f.attempts >= 5) rejectLine(429, "rate_limited");
  await admit(c, `exchange:${f.org_id}:${proof.browser}`);
  if (f.invitation_hash) await admit(c, `invite:${f.invitation_hash}`, 5);
  const contactUser = f.contact_id ? (await c.query("SELECT app.b033_contact_user($1,$2,$3) AS id", [f.org_id, f.contact_id, f.persona])).rows[0].id : null;
  if (contactUser) await admit(c, `credentials:${contactUser}`, 10);
  await c.query("UPDATE app.b033_line_flows SET attempts=attempts+1 WHERE id=$1", [f.id]);
 });
}
export async function verifyFlowOn(c: Client, f: LineFlow, idToken: string, resolve: SecretResolver, oauth = false) {
 const ch = await channelOn(c, f.org_id, f.persona);
 const secrets = await resolve(ch.login_channel_secret_ref);
 if (!secrets?.secret || !secrets.identityPepper) rejectLine(503, "line_unavailable");
 if (!oauth && f.oauth_started_at) rejectLine(400, "invalid_request");
 const sub = verifyLoginToken(idToken, secrets.secret, ch.login_channel_id, oauth ? f.nonce_hash : undefined);
 const hash = providerUserHash(ch.line_provider_id, sub, secrets.identityPepper);
 if (f.verified_hash && f.verified_hash !== hash) rejectLine(409, "identity_conflict");
 await c.query("UPDATE app.b033_line_flows SET verified_hash=$2,verified_at=now() WHERE id=$1", [f.id, hash]);
 f.verified_hash = hash;
 return hash;
}
async function credentialsOn(c: Client, userId: string, input: AuthInput, requirePassword = true) {
 const account = (await c.query<Account>(`SELECT id,email,email_confirmed_at,
  encrypted_password IS NOT NULL AND encrypted_password<>'' AS has_password,
  encrypted_password=crypt($2,encrypted_password) AS matches FROM auth.users WHERE id=$1 FOR UPDATE`, [userId, input.password ?? ""])).rows[0];
 const attempts = (await c.query("SELECT locked_until FROM auth_login_attempts WHERE email=(SELECT email FROM auth.users WHERE id=$1)", [userId])).rows[0];
 if (!account?.email_confirmed_at || mintedLoginEmail(account.email) || lockActive(attempts?.locked_until ?? null, new Date())
  || (requirePassword && (!account.has_password || !account.matches))) rejectLine(401, "reauth_required");
 const mfa = (await c.query("SELECT * FROM user_mfa WHERE user_id=$1 FOR UPDATE", [userId])).rows[0];
 const required = (await c.query(`SELECT EXISTS(SELECT 1 FROM org_members m JOIN organizations o ON o.id=m.org_id
  WHERE m.user_id=$1 AND m.status='active' AND o.settings->>'require_2fa'='true') AS yes`, [userId])).rows[0].yes;
 if (mfa?.enabled || required) {
  if (!mfa?.enabled || !mfa.totp_secret || !verifyTotp(mfa.totp_secret, input.secondFactor ?? "")) rejectLine(401, "reauth_required");
 }
 return { ...account, mfaVerified: Boolean(mfa?.enabled || required) };
}
/** Only explicit password + required MFA verification can create recent-auth evidence. */
export async function stepUpLine(input: AuthInput & { orgId: string; persona: LinePersona }) {
 // Persist failed-attempt admission even when credential verification rolls back.
 await lineTransaction(async c => {
  await channelOn(c, input.orgId, input.persona);
  const session = await sessionOn(c, input.sessionToken);
  if (!session) rejectLine(401, "reauth_required");
  await admit(c, `stepup:${session.user_id}`, 10);
 });
 return lineTransaction(async c => {
  await channelOn(c, input.orgId, input.persona);
  const session = await sessionOn(c, input.sessionToken);
  if (!session) rejectLine(401, "reauth_required");
  const account = await credentialsOn(c, session.user_id, input);
  await c.query(`INSERT INTO app.b033_line_stepups(session_id,authenticated_at,mfa_verified,credential_hash)
   SELECT $1,clock_timestamp(),$3,encode(digest(u.encrypted_password||coalesce(m.totp_secret,'')||coalesce(m.enabled,false)::text,'sha256'),'hex')
   FROM auth.users u LEFT JOIN user_mfa m ON m.user_id=u.id WHERE u.id=$2
   ON CONFLICT(session_id) DO UPDATE SET authenticated_at=excluded.authenticated_at,
    mfa_verified=excluded.mfa_verified,credential_hash=excluded.credential_hash`, [session.id, session.user_id, account.mfaVerified]);
  return { status: "reauthenticated" };
 });
}
export async function consentNextOn(c: Client, userId: string, f: Pick<LineFlow, "persona" | "return_path">) {
 const record = (await c.query<StoredConsent>(`SELECT accepted_at::text,terms_version,privacy_version,source
  FROM public.consents WHERE user_id=$1 ORDER BY recorded_at DESC,id DESC LIMIT 1`, [userId])).rows[0] ?? null;
 if (consentCoversCurrent(record)) return f.return_path;
 return `${f.persona === "vendor" ? "/consent" : "/consent/portal"}?next=${encodeURIComponent(f.return_path)}`;
}
async function auditOn(c: Client, f: LineFlow, userId: string, event: string, linkId?: string) {
 await c.query(`INSERT INTO audit_log(org_id,actor_user_id,actor_role,table_name,row_id,action,event_type,new_row)
  VALUES($1,$2,'app','b033_line_events',$3,'insert',$4,$5::jsonb)`,
  [f.org_id, userId, linkId ?? f.id, event, JSON.stringify({ persona: f.persona, ...(linkId ? { linkId } : {}) })]);
}
async function lineSessionOn(c: Client, f: LineFlow, userId: string, identityId: string, meta: RequestMeta, sessionToken?: string) {
 const existing = await sessionOn(c, sessionToken);
 if (existing && existing.user_id !== userId) rejectLine(409, "account_mismatch");
 // Reuse a valid same-user Condola session across entry and QR/invite paths. Never mint a second one.
 if (existing) return sessionToken!;
 const token = await createSessionOn(c, userId, false, meta);
 await c.query(`INSERT INTO app.b033_line_sessions(session_id,identity_id,flow_id)
  SELECT id,$2,$3 FROM auth_sessions WHERE token_hash=$1`, [lineHash(token), identityId, f.id]);
 await auditOn(c, f, userId, "line_sign_in");
 return token;
}
export async function sessionFromFlowOn(c: Client, f: LineFlow, meta: RequestMeta, auth: AuthInput) {
 const job = await finishVendorFlowOn(c, f);
 if (job) return job;
 const ident = (await c.query(`SELECT * FROM app.b033_line_identities WHERE line_channel_id=$1 AND provider_user_hash=$2 FOR UPDATE`,
  [f.line_channel_id, f.verified_hash])).rows[0];
 const link = ident && (await c.query(`SELECT l.id FROM line_account_links l WHERE l.login_identity_id=$1
  AND l.org_id=$2 AND l.persona=$3 AND l.status='linked' AND l.unlinked_at IS NULL
  AND app.b033_contact_user(l.org_id,l.contact_id,l.persona)=$4 FOR SHARE`, [ident.id, f.org_id, f.persona, ident.user_id])).rows[0];
 if (!ident || ident.status !== "linked" || ident.unlinked_at || !link) return { action: "account_required" as const };
 await credentialsOn(c, ident.user_id, auth, false); // Required second factor also applies to LINE sign-in.
 const token = await lineSessionOn(c, f, ident.user_id, ident.id, meta, auth.sessionToken);
 await c.query("UPDATE app.b033_line_flows SET consumed_at=now() WHERE id=$1", [f.id]);
 return { next: await consentNextOn(c, ident.user_id, f), token, orgId: f.org_id, persona: f.persona };
}
export async function exchangeLineSession(handle: string, proof: BrowserProof, idToken: string, resolve: SecretResolver, meta: RequestMeta, auth: AuthInput) {
 await admitFlow(handle, proof);
 return lineTransaction(async c => {
  const f = await flowOn(c, handle, proof, true);
  await verifyFlowOn(c, f, idToken, resolve);
  if (f.kind !== "login") return { action: "account_required" as const };
  const result = await sessionFromFlowOn(c, f, meta, auth);
  // Unknown identity is a terminal login attempt. Binding always uses a new, user-bound flow.
  if ("action" in result) await c.query("UPDATE app.b033_line_flows SET consumed_at=now() WHERE id=$1", [f.id]);
  return result;
 });
}
export async function acceptLineLink(input: AuthInput & { flow: string; idToken?: string; consentTextKey?: string; orgId?: string; contactId?: string },
 proof: BrowserProof, resolve: SecretResolver, meta: RequestMeta, purpose: "invite" | "bind") {
 await admitFlow(input.flow, proof);
 return lineTransaction(async c => {
  // Canonical lock order: invitation -> flow -> user/contact -> provider identity/link -> session.
  const peek = await flowOn(c, input.flow, proof);
  const invitation = peek.invitation_id && peek.invitation_hash ? await inviteOn(c, peek.invitation_id, peek.invitation_hash) : null;
  const f = await flowOn(c, input.flow, proof, true);
  if (f.kind !== purpose || (purpose === "invite" && !invitation)) rejectLine(400, "invalid_request");
  if (input.orgId && input.orgId !== f.org_id || input.contactId && input.contactId !== f.contact_id) rejectLine(404, "not_found");
  if (input.consentTextKey !== "line.binding.v1") rejectLine(403, "consent_required");
  if (input.idToken) await verifyFlowOn(c, f, input.idToken, resolve);
  if (!f.verified_hash) rejectLine(401, "invalid_line_token");
  let userId = f.user_id;
  const session = await sessionOn(c, input.sessionToken, purpose === "bind");
  if (purpose === "bind") {
   if (!session || session.user_id !== userId) rejectLine(401, "reauth_required");
   if ((await c.query("SELECT app.b033_contact_user($1,$2,$3) AS id", [f.org_id, f.contact_id, f.persona])).rows[0].id !== userId) rejectLine(404, "not_found");
  } else {
   if (invitation!.org_id !== f.org_id || invitation!.contact_id !== f.contact_id || invitation!.kind !== f.persona) rejectLine(404, "not_found");
   const contact = (await c.query(`SELECT c.*,u.email AS login_email FROM contacts c LEFT JOIN auth.users u ON u.id=c.user_id
    WHERE c.org_id=$1 AND c.id=$2 AND c.archived_at IS NULL
    AND CASE $3 WHEN 'tenant' THEN c.is_tenant WHEN 'owner' THEN c.is_owner ELSE false END FOR UPDATE OF c`, [f.org_id, f.contact_id, f.persona])).rows[0];
   if (!contact) rejectLine(404, "not_found");
   if (f.persona === "tenant" && !(await c.query("SELECT 1 FROM lease_parties WHERE org_id=$1 AND contact_id=$2 AND lease_id=$3 AND role='primary'", [f.org_id, f.contact_id, invitation!.lease_id])).rows[0]) rejectLine(404, "not_found");
   const pinnedEmail = portalShownEmail(contact.login_email, invitation!.email ?? contact.email);
   const target = normalizeEmail(pinnedEmail || input.email || "");
   if (!target || mintedLoginEmail(target) || input.email && normalizeEmail(input.email) !== target) rejectLine(409, "account_mismatch");
   const account = (await c.query<Account>("SELECT id,email,email_confirmed_at FROM auth.users WHERE lower(email)=lower($1) FOR UPDATE", [target])).rows[0];
   if (account) {
    if (contact.user_id && contact.user_id !== account.id) rejectLine(409, "account_mismatch");
    await credentialsOn(c, account.id, input);
    userId = account.id;
   } else {
    // A collected address requires prior Condola email verification; never trust the LINE email claim.
    // A pinned invitation email is verified by possession of its existing invitation credential.
    if (!pinnedEmail || contact.user_id || !passwordAcceptable(input.password ?? "")) rejectLine(401, "reauth_required");
    userId = await provisionAcceptedLogin(c, { email: target, name: contact.display_name, phone: contact.phone_e164, password: input.password! });
    if (!userId) rejectLine(409, "account_mismatch");
   }
   if (session && session.user_id !== userId) rejectLine(409, "account_mismatch");
   await c.query("UPDATE contacts SET user_id=$3 WHERE org_id=$1 AND id=$2 AND (user_id IS NULL OR user_id=$3)", [f.org_id, f.contact_id, userId]);
  }
  if (!userId) rejectLine(401, "reauth_required");
  const linkId = (await c.query("SELECT app.b033_link($1,$2,$3,$4) AS id", [f.id, f.verified_hash, userId, input.consentTextKey])).rows[0].id as string;
  if (invitation) {
   await c.query("UPDATE invitations SET status='accepted',accepted_by=$2,accepted_at=now() WHERE id=$1", [invitation.id, userId]);
   await c.query("DELETE FROM portal_invite_secrets WHERE invitation_id=$1", [invitation.id]);
  }
  await auditOn(c, f, userId, "line_link", linkId);
  const identity = (await c.query("SELECT login_identity_id FROM line_account_links WHERE id=$1", [linkId])).rows[0].login_identity_id;
  const token = purpose === "invite" ? await lineSessionOn(c, f, userId, identity, meta, input.sessionToken) : undefined;
  await c.query("UPDATE app.b033_line_flows SET consumed_at=now() WHERE id=$1", [f.id]);
  return { next: purpose === "invite" ? await consentNextOn(c, userId, f) : f.return_path, linkId, status: "linked", token, orgId: f.org_id, persona: f.persona };
 });
}

export async function startLineLogin(handle: string, proof: BrowserProof, origin: string) {
 return lineTransaction(async c => {
  const f = await flowOn(c, handle, proof, true);
  if (f.oauth_started_at || f.verified_hash) rejectLine(409, "already_consumed");
  const channel = await channelOn(c, f.org_id, f.persona);
  const state = randomProof(), nonce = randomProof(), verifier = randomProof();
  await c.query(`UPDATE app.b033_line_flows SET state_hash=$2,nonce_hash=$3,pkce_hash=$4,oauth_started_at=now() WHERE id=$1`,
   [f.id, lineHash(state), lineHash(nonce), lineHash(verifier)]);
  const url = new URL("https://access.line.me/oauth2/v2.1/authorize");
  url.search = new URLSearchParams({ response_type: "code", client_id: channel.login_channel_id,
   redirect_uri: `${origin}/api/line/login/callback`, state, nonce, scope: "openid",
   code_challenge: Buffer.from(lineHash(verifier), "hex").toString("base64url"), code_challenge_method: "S256" }).toString();
  return { url: url.toString(), verifier };
 });
}
/** Token-endpoint exchange contract; the live implementation is createLineCodeExchange in oauth-exchange.ts. */
export type LineCodeExchange = (input: { code: string; verifier: string; redirectUri: string; channelId: string; secretRef: string }) => Promise<string>;
export async function callbackLineLogin(input: { flow: string; state: string; code?: string; error?: string; verifier: string; origin: string },
 proof: BrowserProof, resolve: SecretResolver, exchange: LineCodeExchange, meta: RequestMeta, auth: AuthInput) {
 // Check state before any credential exchange or admission write.
 await lineTransaction(async c => {
  const f = await flowOn(c, input.flow, proof);
  if (!f.oauth_started_at || !equalHash(input.state, f.state_hash) || !equalHash(input.verifier, f.pkce_hash)) rejectLine(401, "invalid_line_token");
 });
 await admitFlow(input.flow, proof);
 return lineTransaction(async c => {
  const peek = await flowOn(c, input.flow, proof);
  if (peek.invitation_id && peek.invitation_hash) await inviteOn(c, peek.invitation_id, peek.invitation_hash);
  const f = await flowOn(c, input.flow, proof, true);
  if (!f.oauth_started_at || !equalHash(input.state, f.state_hash) || !equalHash(input.verifier, f.pkce_hash)) rejectLine(401, "invalid_line_token");
  if (input.error) { await c.query("UPDATE app.b033_line_flows SET consumed_at=now() WHERE id=$1", [f.id]); return { next: "/login" }; }
  if (!input.code || f.verified_hash) rejectLine(409, "already_consumed");
  const ch = await channelOn(c, f.org_id, f.persona);
  const idToken = await exchange({ code: input.code, verifier: input.verifier, redirectUri: `${input.origin}/api/line/login/callback`,
   channelId: ch.login_channel_id, secretRef: ch.login_channel_secret_ref });
  await verifyFlowOn(c, f, idToken, resolve, true);
  if (f.kind !== "login") return { next: `${f.persona === "tenant" ? "/t" : f.persona === "vendor" ? "/v" : "/o"}/liff?flow=${encodeURIComponent(input.flow)}` };
  const result = await sessionFromFlowOn(c, f, meta, auth);
  if ("action" in result) { await c.query("UPDATE app.b033_line_flows SET consumed_at=now() WHERE id=$1", [f.id]); return { next: "/login" }; }
  return result;
 });
}
export async function listLineLinks(sessionToken?: string) {
 return lineTransaction(async c => {
  if (!readLineConfig().platformEnabled) rejectLine(404, "not_found");
  const session = await sessionOn(c, sessionToken);
  if (!session) rejectLine(401, "reauth_required");
  // Identity ownership retains access to historical links after account reassignment.
  // Current contact mappings authorize binding/login/push, not listing or self-unlink.
  const rows = (await c.query(`SELECT l.id,l.org_id AS "orgId",l.persona,l.login_identity_id AS "identityId",l.status,l.is_friend AS "isFriend",l.notification_opt_in AS "notificationOptIn"
   FROM line_account_links l JOIN app.b033_line_identities i ON i.id=l.login_identity_id
   WHERE i.user_id=$1 AND app.b033_portal_enabled(l.org_id,l.persona) ORDER BY l.id`, [session.user_id])).rows;
  if (!rows.length) {
   if ((await c.query("SELECT 1 FROM app.b033_line_identities WHERE user_id=$1 LIMIT 1", [session.user_id])).rows[0]) rejectLine(404, "not_found");
   const enabled = (await c.query(`SELECT 1 FROM contacts c CROSS JOIN (VALUES('tenant'),('owner'),('vendor')) p(persona)
    WHERE app.b033_contact_user(c.org_id,c.id,p.persona)=$1 AND app.b033_portal_enabled(c.org_id,p.persona) LIMIT 1`, [session.user_id])).rows[0];
   if (!enabled) rejectLine(404, "not_found");
  }
  return { links: rows };
 });
}
export async function unlinkLine(id: string, sessionToken: string | undefined, reason: string) {
 return lineTransaction(async c => {
  if (!readLineConfig().platformEnabled) rejectLine(404, "not_found");
  const session = await sessionOn(c, sessionToken);
  if (!session) rejectLine(401, "reauth_required");
  const link = (await c.query(`SELECT l.*,i.user_id FROM line_account_links l JOIN app.b033_line_identities i ON i.id=l.login_identity_id
   WHERE l.id=$1`, [id])).rows[0];
  if (!link?.persona) rejectLine(404, "not_found");
  const own = link.user_id === session.user_id;
  const admin = (await c.query(`SELECT 1 FROM org_members WHERE org_id=$1 AND user_id=$2 AND status='active' AND role IN ('admin','manager')`, [link.org_id, session.user_id])).rows[0];
  if (!own && !admin) rejectLine(404, "not_found");
  await channelOn(c, link.org_id, link.persona);
  if (own && !(await sessionOn(c, sessionToken, true))) rejectLine(401, "reauth_required");
  if (!["user_request", "staff_request"].includes(reason)) rejectLine(400, "invalid_request");
  await admit(c, `unlink:${session.user_id}`);
  // Same identity-before-link order as bind and global revoke.
  await c.query("SELECT id FROM app.b033_line_identities WHERE id=$1 FOR UPDATE", [link.login_identity_id]);
  // B-017: a staff unlink manages another person's contact channel. After the business waits and
  // before the write, re-check current effective authority for the link's org (restrict-only; native
  // admin/manager hold tenants.contact, so native behaviour is unchanged). SQL holds it until COMMIT.
  if (!own) {
   try {
    await requireEffectivePerm(c, { kind: "staff", orgId: link.org_id, liveOrgId: link.org_id, userId: session.user_id, sessionId: session.id }, "tenants.contact");
   } catch (error) {
    if (error instanceof FlowError) rejectLine(404, "not_found");
    throw error;
   }
  }
  await c.query("UPDATE line_account_links SET status='unlinked',unlinked_at=now(),notification_opt_in=false WHERE id=$1", [id]);
  await c.query(`INSERT INTO audit_log(org_id,actor_user_id,actor_role,table_name,row_id,action,event_type,reason)
   VALUES($1,$2,'app','b033_line_events',$3,'update','line_unlink',$4)`, [link.org_id, session.user_id, id, reason]);
  return { status: "unlinked" };
 });
}
export async function revokeLineIdentity(sessionToken?: string, identityId?: string) {
 return lineTransaction(async c => {
  if (!readLineConfig().platformEnabled) rejectLine(404, "not_found");
  const session = await sessionOn(c, sessionToken, true);
  if (!session) rejectLine(401, "reauth_required");
  const identities = (await c.query(`SELECT * FROM app.b033_line_identities WHERE user_id=$1 AND status='linked'
   AND ($2::uuid IS NULL OR id=$2) ORDER BY id FOR UPDATE`, [session.user_id, identityId ?? null])).rows;
  if (identities.length !== 1) rejectLine(404, "not_found");
  const ident = identities[0];
  const links = (await c.query("SELECT * FROM line_account_links WHERE login_identity_id=$1 FOR UPDATE", [ident.id])).rows;
  if (!links.length) rejectLine(404, "not_found");
  for (const link of links) await channelOn(c, link.org_id, link.persona);
  const recovery = (await c.query(`SELECT email FROM auth.users WHERE id=$1 AND email_confirmed_at IS NOT NULL
   AND encrypted_password IS NOT NULL AND encrypted_password<>''`, [session.user_id])).rows[0];
  if (!recovery || !normalizeEmail(recovery.email) || mintedLoginEmail(recovery.email)) rejectLine(401, "reauth_required");
  await admit(c, `revoke:${session.user_id}`);
  await c.query("UPDATE line_account_links SET status='unlinked',unlinked_at=now(),notification_opt_in=false WHERE login_identity_id=$1", [ident.id]);
  await c.query("UPDATE app.b033_line_identities SET status='revoked',unlinked_at=now() WHERE id=$1", [ident.id]);
  await c.query(`UPDATE auth_sessions SET revoked_at=now() WHERE id IN
   (SELECT session_id FROM app.b033_line_sessions WHERE identity_id=$1) AND revoked_at IS NULL`, [ident.id]);
  await c.query(`INSERT INTO audit_log(actor_user_id,actor_role,table_name,row_id,action,event_type)
   VALUES($1,'app','b033_line_events',$2,'update','line_identity_revoke')`, [session.user_id, ident.id]);
  return { status: "revoked" };
 });
}
