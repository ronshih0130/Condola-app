import type { Client } from 'pg';
import { svc } from './db';
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
  try { return await scoped(s, async c => {
    const state = (await c.query<{state:TenantPasswordResult}>(`SELECT app.b020_change_password($1,$2,$3,$4,$5,$6) state`,
      [s.orgId,s.sessionId,input.currentPassword,input.password,LOCKOUT_LIMIT,LOCKOUT_MS])).rows[0].state;
    if (state === 'changed') await audit(c,s,'tenant_password_changed');
    return state;
  }); } catch { return 'unavailable'; }
}
