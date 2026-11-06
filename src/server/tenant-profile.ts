import type { Client } from 'pg';
import { timingSafeEqual } from 'node:crypto';
import { svc } from './db';
import { assertPasswordProviderConfigured, writeHardenedPassword } from './auth';
import { beginCredentialChange, credentialTransaction, finishCredentialChange, sessionHardeningEnabled } from './session-hardening';
import { requireOrgScope } from './org-guard';
import { isUuid } from './repair-rules';
import { recordAudit } from './audit-write';
import { LOCKOUT_LIMIT, LOCKOUT_MS } from './lockout';
import { parseTenantProfile, tenantPasswordIssue } from './tenant-profile-rules';
import type { Session } from './types';

export type TenantProfile = { display_name: string; phone_e164: string; version: string };
export type TenantPasswordResult = 'changed' | 'invalid' | 'locked' | 'reauth' | 'weak' | 'mismatch' | 'unavailable';
function eligible(s: Session) { return s.kind === 'tenant' && [s.userId,s.orgId,s.sessionId].every(isUuid); }
async function scoped<T>(s: Session, fn: (c: Client) => Promise<T>): Promise<T> {
  const scope = requireOrgScope(s);
  if (!('orgId' in scope)) throw new Error('Missing scope');
  return svc(s.userId, async c => {
    await c.query(`SELECT set_config('app.active_org_id',$1,true),set_config('app.env',$2,true)`, [scope.orgId,scope.environment]);
    await c.query(`SET LOCAL lock_timeout='5s'`);
    return fn(c);
  });
}
async function audit(c: Client, s: Session, event: string) {
  // Metadata only: no name, phone, password or password hash reaches the audit payload.
  await recordAudit({ orgId:s.orgId, actorUserId:s.userId, actorRole:'tenant' },
    { table:'b020_tenant_profiles', rowId:s.userId, action:'update', eventType:event,
      newRow:{ scope:'account', outcome:'updated', environment:s.environment } }, c);
}
export async function tenantProfile(s: Session): Promise<TenantProfile | null> {
  if (!eligible(s)) return null;
  try { return await scoped(s, async c => (await c.query<TenantProfile>(`SELECT * FROM app.b020_profile($1,$2)`,[s.orgId,s.sessionId])).rows[0] ?? null); }
  catch { return null; }
}
/** Mutations consume a database per-user budget only after flag/session admission.
 * Identity fields from the submitted form are ignored; only the resolved session supplies authority. */
export async function saveTenantProfile(s: Session, input: Record<string, unknown>): Promise<'updated'|'stale'|'invalid'|'unavailable'> {
  const data = parseTenantProfile(input);
  if (!data) return 'invalid';
  if (!eligible(s)) return 'unavailable';
  try { return await scoped(s, async c => {
    const state = (await c.query<{state:'updated'|'stale'|'unavailable'}>(`SELECT app.b020_save_profile($1,$2,$3,$4,$5) state`,[s.orgId,s.sessionId,data.name,data.phone,data.version])).rows[0].state;
    if (state === 'updated') await audit(c,s,'tenant_profile_changed');
    return state;
  }); } catch { return 'unavailable'; }
}
export async function changeTenantPassword(s: Session, input: Record<string, unknown>): Promise<TenantPasswordResult> {
  const issue = tenantPasswordIssue(input);
  if (issue) return issue;
  if (!eligible(s)) return 'unavailable';
  try {
    if (await sessionHardeningEnabled()) return await changeHardenedTenantPassword(s, input);
    return await scoped(s, async c => {
    const state = (await c.query<{state:TenantPasswordResult}>(`SELECT app.b020_change_password($1,$2,$3,$4,$5,$6) state`,
      [s.orgId,s.sessionId,input.currentPassword,input.password,LOCKOUT_LIMIT,LOCKOUT_MS])).rows[0].state;
    if (state === 'changed') await audit(c,s,'tenant_password_changed');
    return state;
  }); } catch { return 'unavailable'; }
}

/** B-031 owns the epoch and provider protocol; B-020 still owns tenant admission,
 * current-password proof, lockout and mutation budgets. No lock spans the provider. */
async function changeHardenedTenantPassword(s: Session, input: Record<string, unknown>): Promise<TenantPasswordResult> {
  // Preserve the read-only OFF path; preflight locks end before recovery starts.
  if (!await tenantProfile(s)) return 'unavailable';
  assertPasswordProviderConfigured();
  const scope = requireOrgScope(s);
  if (!('orgId' in scope)) return 'unavailable';
  const epoch = await credentialTransaction(async c => {
    await c.query(`SELECT set_config('request.jwt.claim.sub',$1,true),set_config('app.active_org_id',$2,true),set_config('app.env',$3,true)`,
      [s.userId,scope.orgId,scope.environment]);
    // Recovery commits independently, so its own transaction must authorize it.
    // Epoch first, then user and admission rows; hold authorization through commit.
    await c.query(`INSERT INTO app.b031_credential_epochs(user_id) VALUES($1) ON CONFLICT DO NOTHING`, [s.userId]);
    await c.query(`SELECT 1 FROM app.b031_credential_epochs WHERE user_id=$1 FOR UPDATE`, [s.userId]);
    await c.query(`SELECT 1 FROM auth.users WHERE id=$1 FOR UPDATE`, [s.userId]);
    await c.query(`SELECT app.b020_profile_admit($1,$2)`, [s.orgId,s.sessionId]);
    await c.query(`SELECT app.b031_reconcile_credential_change($1::uuid)`, [s.userId]);
    return (await c.query<{epoch:string}>(`SELECT app.b031_credential_epoch($1::uuid)::text AS epoch`, [s.userId])).rows[0].epoch;
  });
  const prepared = await credentialTransaction(async c => {
    await c.query(`SELECT set_config('request.jwt.claim.sub',$1,true),set_config('app.active_org_id',$2,true),set_config('app.env',$3,true)`,
      [s.userId,scope.orgId,scope.environment]);
    // Take the exclusive epoch lock FIRST (never upgrade concurrent shared locks).
    await c.query(`INSERT INTO app.b031_credential_epochs(user_id) VALUES($1) ON CONFLICT DO NOTHING`, [s.userId]);
    await c.query(`SELECT 1 FROM app.b031_credential_epochs WHERE user_id=$1 FOR UPDATE`, [s.userId]);
    await c.query(`SELECT app.b031_lock_credential_epoch($1::uuid,$2::bigint)`, [s.userId,epoch]);
    const user = (await c.query<{email:string; email_confirmed_at:Date|null}>(
      `SELECT email,email_confirmed_at FROM auth.users WHERE id=$1 FOR UPDATE`, [s.userId])).rows[0];
    await c.query(`SELECT app.b020_profile_admit($1,$2)`, [s.orgId,s.sessionId]);
    const attempt = (await c.query<{failed_count:number; locked_until:Date|null; locked:boolean}>(
      `SELECT failed_count,locked_until,locked_until>clock_timestamp() AS locked
       FROM auth_login_attempts WHERE email=lower($1) FOR UPDATE`, [user.email])).rows[0];
    if (attempt?.locked) return 'locked' as const;
    if (!(await c.query<{ok:boolean}>(`SELECT app.b020_consume_mutation('password') AS ok`)).rows[0].ok) return 'unavailable' as const;
    const proof = (await c.query<{actual:Buffer|null; expected:Buffer|null}>(
      `SELECT public.digest(public.crypt($2,encrypted_password),'sha256') AS actual,
        public.digest(nullif(encrypted_password,''),'sha256') AS expected FROM auth.users WHERE id=$1`,
      [s.userId,input.currentPassword])).rows[0];
    if (!user.email_confirmed_at || !proof.actual || !proof.expected || !timingSafeEqual(proof.actual,proof.expected)) {
      const count = attempt?.locked_until ? 1 : (attempt?.failed_count ?? 0)+1;
      await c.query(`INSERT INTO auth_login_attempts(email,failed_count,locked_until,updated_at)
        VALUES(lower($1),$2::int,CASE WHEN $2::int >= $3::int THEN clock_timestamp()+$4::int*interval '1 millisecond' END,clock_timestamp())
        ON CONFLICT(email) DO UPDATE SET failed_count=EXCLUDED.failed_count,locked_until=EXCLUDED.locked_until,updated_at=EXCLUDED.updated_at`,
      [user.email,count,LOCKOUT_LIMIT,LOCKOUT_MS]);
      return count>=LOCKOUT_LIMIT ? 'locked' as const : 'invalid' as const;
    }
    const change = await beginCredentialChange(c,s.userId,epoch,s.sessionId);
    await c.query(`DELETE FROM auth_login_attempts WHERE email=lower($1)`, [user.email]);
    return change;
  });
  if (typeof prepared === 'string') return prepared;
  const state = await writeHardenedPassword(prepared,input.password as string,undefined,true);
  // A finish/audit failure cannot undo phase 1 or the independently committed provider.
  // Its durable pending marker remains fenced until B-031 recovery.
  await credentialTransaction(async c => {
    await finishCredentialChange(c,prepared,state);
    if (state === 'done') await audit(c,s,'tenant_password_changed');
  });
  return state === 'done' ? 'changed' : 'unavailable';
}
