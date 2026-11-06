import { createStaffEmailMockAdapter } from './staff-email-provider';
import { canonicalStaffEmail } from './staff-email-rules';

export type EmailFlowScope = { userId: string; orgId: string; sessionId: string };
export type EmailFlowAdmission = EmailFlowScope & {
  kind: string; role: string; environment: string; liveOrgId: string;
  activeMember: boolean; revoked: boolean; expiresAt: number; flag: unknown;
};
export type EmailFlowPending = {
  id: string; userId: string; orgId: string; version: string;
  current: string; target: string; expiresAt: number; privileged: readonly string[];
};
export type EmailFlowCanonical = Readonly<{
  userId: string; email: string; confirmed: true; version: string;
}>;
type Adapter = ReturnType<typeof createStaffEmailMockAdapter>;
export type EmailFlowPorts = {
  // Resolve current server authority, never echo client claims or a cached admission.
  admit(scope: EmailFlowScope): Promise<EmailFlowAdmission | null>;
  loadPending(scope: EmailFlowScope): Promise<EmailFlowPending | null>;
  provider: Pick<Adapter, 'verify'>;
  // Independent canonical identity store read, never the verification response.
  // Its opaque version/etag must change on every identity or confirmation change,
  // including changes that later restore the same values (no version reuse).
  readCanonical(scope: EmailFlowScope): Promise<unknown>;
  // Future implementation must atomically recheck current authority/session/pending
  // expiry and CAS the pending version + old mirrors AND all expectedCanonical fields
  // (userId, exact email, confirmed, version) against the canonical store, then update
  // mirrors and consume pending exactly once. A separate preflight read is insufficient.
  // false means no writes; throws mean uncertain outcome, never automatic retry.
  commitIdentity(input: { scope: EmailFlowScope; expected: EmailFlowPending;
    expectedCanonical: EmailFlowCanonical; email: string }): Promise<boolean>;
  now(): number;
};
export type EmailFlowResult = 'denied' | 'invalid' | 'expired' | 'partial' | 'rejected' | 'unknown' | 'committed' | 'stale';
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Disconnected verification coordinator. No default transport, storage or runtime callers. */
export function createStaffEmailFlow(ports: EmailFlowPorts) {
  async function allowed(scope: EmailFlowScope): Promise<boolean> {
    if (![scope.userId, scope.orgId, scope.sessionId].every((id) => typeof id === 'string' && uuid.test(id))) return false;
    const a = await ports.admit(scope), now = ports.now();
    return !!a && a.userId === scope.userId && a.orgId === scope.orgId && a.sessionId === scope.sessionId
      && a.liveOrgId === scope.orgId && a.kind === 'staff' && a.environment === 'live'
      && ['admin', 'manager', 'accountant', 'maintenance'].includes(a.role)
      && a.activeMember === true && a.revoked === false && a.flag === true
      && Number.isFinite(now) && Number.isFinite(a.expiresAt) && a.expiresAt > now;
  }
  function expired(p: EmailFlowPending): boolean {
    const now = ports.now();
    return !Number.isFinite(now) || !Number.isFinite(p.expiresAt) || p.expiresAt <= now;
  }
  async function verify(scopeInput: EmailFlowScope, proof: Parameters<Adapter['verify']>[1]): Promise<EmailFlowResult> {
    try {
      // Capture request values before awaits; even throwing getters are contained.
      const scope = { ...scopeInput }, verification = { ...proof };
      if (!await allowed(scope)) return 'denied';
      if (!['current', 'target'].includes(verification.mailbox) || typeof verification.token !== 'string'
        || !/^[0-9]{1,20}$/.test(verification.token)) return 'invalid';
      const stored = await ports.loadPending(scope);
      if (!stored) return 'invalid';
      const pending = { ...stored, privileged: [...stored.privileged] };
      const current = canonicalStaffEmail(pending.current), target = canonicalStaffEmail(pending.target);
      if (pending.userId !== scope.userId || pending.orgId !== scope.orgId || !pending.id || !pending.version
        || !current || !target || current === target
        || pending.privileged.some((email) => !canonicalStaffEmail(email) || [current, target].includes(canonicalStaffEmail(email)!))) return 'invalid';
      if (expired(pending)) return 'expired';
      if (!await allowed(scope)) return 'denied';
      if (expired(pending)) return 'expired';
      const result = await ports.provider.verify({ userId: scope.userId, current, target,
        privileged: pending.privileged, pending: target, pendingUnexpired: true }, verification);
      if (result === 'partial' || result === 'invalid' || result === 'rejected') return result;
      if (result !== 'final_candidate') return 'unknown';
      if (expired(pending)) return 'expired';
      if (!await allowed(scope)) return 'denied';
      const canonical = await ports.readCanonical(scope);
      if (!canonical || typeof canonical !== 'object' || Array.isArray(canonical)) return 'unknown';
      // Copy scalar fields before the next await so a mutable store result cannot
      // silently change the proof used as the commit precondition.
      const { userId, email, confirmed, version } = canonical as Record<string, unknown>;
      if (userId !== scope.userId || typeof email !== 'string' || canonicalStaffEmail(email) !== target
        || confirmed !== true || typeof version !== 'string' || !version.trim()) return 'unknown';
      const expectedCanonical: EmailFlowCanonical = { userId, email, confirmed, version };
      if (!await allowed(scope)) return 'denied';
      if (expired(pending)) return 'expired';
      return await ports.commitIdentity({ scope, expected: pending, expectedCanonical, email: target }) === true ? 'committed' : 'stale';
    } catch {
      // Includes ambiguous persistence results. Do not retry or expose provider details.
      return 'unknown';
    }
  }
  return { verify };
}
