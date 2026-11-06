import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { companyEmailStore } from './company-profiles';
import { createStaffEmailMockAdapter, type MockTransport } from './staff-email-provider';
import { canonicalStaffEmail, normalizeStaffEmail } from './staff-email-rules';
import { platformAdminEmails } from './platform';
import { isUuid } from './repair-rules';
import type { Session } from './types';

type Mailbox = 'current' | 'target';
function tokenHash(id: string, mailbox: Mailbox, token: string) {
  return createHash('sha256').update(`${id}:${mailbox}:${token}`).digest('hex');
}
function newToken() { return BigInt(`0x${randomBytes(8).toString('hex')}`).toString().padStart(20, '0'); }

/** Explicit mock injection only. No fetch, default provider, credentials, route,
 * automatic resend or uncertain-outcome retry is installed by this package. */
export function createCompanyEmailChange(deps: {
  transport: MockTransport;
  capture: (delivery: { id: string; current: string; target: string; currentToken: string; targetToken: string }) => Promise<void>;
}) {
  const provider = createStaffEmailMockAdapter({ projectOrigin: 'https://b016.example.invalid', publicKey: 'mock-only', deadlineMs: 1000, transport: deps.transport });
  async function initiate(s: Session, input: { target: string; password: string; requestId: string }) {
    try {
      if (!isUuid(input.requestId) || typeof input.target !== 'string' || typeof input.password !== 'string' || !input.password) return { state: 'invalid' };
      const identity = await companyEmailStore(s, 'identity', {});
      if (identity.state !== 'ready') return identity;
      const current = canonicalStaffEmail(identity.email), target = normalizeStaffEmail(input.target);
      const privileged = platformAdminEmails();
      if (!current || !target || current === target || privileged.some(e => [current, target].includes(e))) return { state: 'invalid' };
      const id = randomUUID(), currentToken = newToken(), targetToken = newToken();
      const reserved = await companyEmailStore(s, 'begin', { id, request_id: input.requestId, current, target,
        current_hash: tokenHash(id, 'current', currentToken), target_hash: tokenHash(id, 'target', targetToken) });
      if (reserved.state !== 'reserved') return reserved;
      // A durable reservation exists before any mock provider work. An ambiguous
      // result remains private/unknown and cannot trigger an automatic resend.
      const started = await provider.begin({ userId: s.userId, current, target, privileged, pending: null, pendingUnexpired: false }, input.password);
      const result = await companyEmailStore(s, 'started', { id, state: started === 'pending' ? 'pending' : 'unknown' });
      if (result.state === 'pending') await deps.capture({ id, current, target, currentToken, targetToken });
      return result;
    } catch { return { state: 'unknown' }; }
  }
  async function verify(s: Session, input: { id: string; mailbox: Mailbox; token: string }) {
    const attemptId = randomUUID();
    let reserved = false;
    async function uncertain() {
      // If persistence is unavailable, the committed verifying reservation still
      // fences retries. It must be reconciled explicitly, never automatically.
      try { await companyEmailStore(s, 'uncertain', { id: input.id, attempt_id: attemptId }); } catch { /* reservation remains */ }
    }
    try {
      const { id, mailbox, token } = input;
      if (!isUuid(id) || !['current', 'target'].includes(mailbox) || !/^[0-9]{20}$/.test(token)) return { state: 'invalid' };
      const proof = { id, attempt_id: attemptId, mailbox, hash: tokenHash(id, mailbox, token) };
      // Validate the proof and reserve the entire pending request under one row
      // lock/transaction, before sending either mailbox's token to the provider.
      const pending = await companyEmailStore(s, 'reserve_verify', proof);
      if (pending.state !== 'ready') return pending;
      reserved = true;
      const privileged = platformAdminEmails();
      if (!pending.current || !pending.target || privileged.some(e => [pending.current, pending.target].includes(e))) {
        await uncertain(); return { state: 'denied' };
      }
      const result = await provider.verify({ userId: s.userId, current: pending.current, target: pending.target,
        privileged, pending: pending.target, pendingUnexpired: true }, { mailbox, token });
      if (result !== 'partial' && result !== 'final_candidate') {
        await uncertain(); return { state: 'uncertain' };
      }
      const canonical = result === 'final_candidate' ? await companyEmailStore(s, 'identity', {}) : null;
      const finished = await companyEmailStore(s, 'verify', { ...proof, version: pending.version, provider: result, canonical_email: canonical?.email,
        canonical_version: canonical?.version, canonical_confirmed: canonical?.confirmed });
      if (!['partial', 'committed'].includes(finished.state)) await uncertain();
      return finished;
    } catch {
      if (reserved) await uncertain();
      return { state: reserved ? 'uncertain' : 'unknown' };
    }
  }
  return { initiate, verify };
}
