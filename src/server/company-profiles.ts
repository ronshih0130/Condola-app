import { validCompanyData } from './company-profile-rules';
import type { Client } from 'pg';
import { withClient } from './db';
import { recordAudit, svcAuditScope } from './audit-write';
import { authorizeStaffProfile } from './staff-profile';
import { isUuid } from './repair-rules';
import type { Session } from './types';

export type CompanyData = { legal_name: string; tax_id: string; address: { city: string; district: string; street: string } };
export type CompanyResult = { state: 'ready' | 'updated' | 'replayed' | 'denied' | 'invalid' | 'stale' | 'unavailable';
  version?: string | null; country?: 'TW'; data?: CompanyData };
export type EmailStoreResult = { state: string; id?: string; version?: string; email?: string;
  confirmed?: boolean; current?: string; target?: string };

function eligible(s: Session, admin: boolean) {
  return s.kind === 'staff' && !s.needsSandbox && s.environment === 'live' && s.orgId === s.liveOrgId
    && [s.userId, s.orgId, s.sessionId].every(isUuid)
    && (admin ? s.role === 'admin' : ['admin', 'manager', 'accountant', 'maintenance'].includes(s.role ?? ''));
}

/** One transaction holds flag/session/membership fences through audit and commit.
 * The session is server-resolved; no target actor/org is accepted from form data. */
async function gateway<T extends { state: string }>(s: Session, kind: 'company' | 'email', op: string,
  payload: object): Promise<T | { state: 'denied' | 'unavailable' }> {
  if (!eligible(s, kind === 'company')) return { state: 'denied' };
  return withClient<T | { state: 'denied' | 'unavailable' }>(async (c: Client) => {
    try {
      await c.query('BEGIN');
      await c.query(`SELECT set_config('request.jwt.claim.sub',$1,true),
        set_config('request.jwt.claim.role','service_role',true),
        set_config('app.active_org_id',$2,true),set_config('app.env','live',true)`, [s.userId, s.orgId]);
      await c.query('SET LOCAL ROLE service_role');
      await c.query("SET LOCAL lock_timeout='2s'");
      await c.query('LOCK TABLE public.platform_settings IN SHARE MODE');
      if (!await authorizeStaffProfile(c, s)) { await c.query('ROLLBACK'); return { state: 'denied' }; }
      const sql = kind === 'company'
        ? 'SELECT app.b016_company_profile_gateway($1,$2,$3,$4::jsonb) AS result'
        : 'SELECT app.b016_email_gateway($1,$2,$3,$4::jsonb) AS result';
      const result = (await c.query<{ result: T }>(sql, [s.sessionId, s.orgId, op, JSON.stringify(payload)])).rows[0].result;
      if (kind === 'company' && result.state === 'updated') {
        // Gateway independently records the mutation. This app receipt uses the
        // standard masked audit writer; values never enter either audit event.
        await recordAudit(svcAuditScope({ orgId: s.orgId, actorUserId: s.userId, actorRole: s.role! }), {
          table: 'b016_company_profiles', rowId: s.orgId, action: 'update', eventType: 'company_profile_save_confirmed',
          newRow: { fields: ['legal_name', 'tax_id', 'address'], values: '[masked]' },
          requestId: (payload as { request_id: string }).request_id,
        }, c);
      }
      await c.query('SET CONSTRAINTS ALL IMMEDIATE');
      if (!await authorizeStaffProfile(c, s)) throw new Error('Admission changed');
      if ((await c.query('COMMIT')).command !== 'COMMIT') throw new Error('Unconfirmed commit');
      return result;
    } catch {
      await c.query('ROLLBACK');
      return { state: 'unavailable' };
    }
  }).catch(() => ({ state: 'unavailable' as const }));
}

export async function companyProfileView(s: Session): Promise<CompanyResult> {
  return gateway<CompanyResult>(s, 'company', 'read', {});
}
export async function saveCompanyProfile(s: Session, input: { data: CompanyData; expectedVersion: string | null; requestId: string }): Promise<CompanyResult> {
  if (!validCompanyData(input.data) || !isUuid(input.requestId) || (input.expectedVersion !== null && !isUuid(input.expectedVersion))) return { state: 'invalid' };
  return gateway<CompanyResult>(s, 'company', 'save', { data: input.data, expected_version: input.expectedVersion, request_id: input.requestId });
}
/** Internal durable adapter; not a server action or client-selected operation. */
export async function companyEmailStore(s: Session, op: string, payload: object): Promise<EmailStoreResult> {
  return gateway<EmailStoreResult>(s, 'email', op, payload);
}
