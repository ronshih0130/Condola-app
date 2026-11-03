import { assessStaffEmail, canonicalStaffEmail, normalizeStaffEmail } from './staff-email-rules';

type Reply = { status: number; json(): Promise<unknown> };
export type MockTransport = (url: string, init: { method: 'GET' | 'POST' | 'PUT'; headers: Record<string,string>; body?: string; redirect: 'error'; signal: AbortSignal }) => Promise<Reply>;
type Config = { projectOrigin: string; publicKey: string; deadlineMs: number; transport: MockTransport };
type TrustedState = { userId: string; current: string; target: string; privileged: readonly string[]; pending: string | null; pendingUnexpired: boolean };
type Result = 'invalid' | 'excluded' | 'unchanged' | 'pending' | 'rejected' | 'unavailable' | 'unknown' | 'partial' | 'final_candidate';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const partialMessage = 'Confirmation link accepted. Please proceed to confirm link sent to the other email';
function obj(v: unknown): Record<string, unknown> | null { return v !== null && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : null; }
// Provider evidence is never repaired like form input; only case is folded.
function canonicalEvidence(value: unknown, expected: string): boolean {
  return canonicalStaffEmail(value) === expected;
}
function hasErrorMarkers(value: Record<string, unknown>): boolean {
  return ['error', 'error_code', 'error_description', 'msg', 'code'].some((key) => key in value);
}
function validConfirmationTime(value: unknown): boolean {
  if (typeof value !== 'string') return false;
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(Z|[+-]\d{2}:\d{2})$/.exec(value);
  if (!match) return false;
  const [, year, month, day, hour, minute, second, zone] = match;
  const y = Number(year), m = Number(month), d = Number(day);
  if (y < 1 || m < 1 || m > 12 || d < 1 || d > new Date(Date.UTC(y < 100 ? y + 400 : y, m, 0)).getUTCDate() || Number(hour) > 23 || Number(minute) > 59 || Number(second) > 59) return false;
  if (zone !== 'Z' && (Number(zone.slice(1, 3)) > 23 || Number(zone.slice(4, 6)) > 59)) return false;
  return Number.isFinite(Date.parse(value));
}
function verifiedUser(value: unknown, userId: string, email: string): boolean {
  const u = obj(value); if (!u || hasErrorMarkers(u) || u.id !== userId || u.is_anonymous !== false || (u.is_sso_user !== undefined && u.is_sso_user !== false) || !validConfirmationTime(u.email_confirmed_at) || !canonicalEvidence(u.email, email)) return false;
  const metadata = obj(u.app_metadata);
  if (!metadata || metadata.provider !== 'email' || !Array.isArray(metadata.providers) || metadata.providers.length !== 1 || metadata.providers[0] !== 'email') return false;
  // A complete GET /user representation may omit factors when none exist.
  if (u.factors !== undefined && (!Array.isArray(u.factors) || u.factors.length !== 0)) return false;
  if (!Array.isArray(u.identities) || u.identities.length !== 1) return false;
  const identity = obj(u.identities[0]), data = obj(identity?.identity_data);
  return !!identity && typeof identity.id === 'string' && identity.id.length > 0 && identity.user_id === userId && identity.provider === 'email' && !!data && canonicalEvidence(data.email, email) && (identity.email === undefined || canonicalEvidence(identity.email, email)) && data.email_verified === true;
}
function validatedConfig(c: Config): string | null {
  try {
    const u = new URL(c.projectOrigin);
    if (u.protocol !== 'https:' || u.username || u.password || u.pathname !== '/' || u.search || u.hash || u.origin !== c.projectOrigin || !c.publicKey || /[\s\x00-\x1f\x7f]/.test(c.publicKey) || !Number.isInteger(c.deadlineMs) || c.deadlineMs < 1 || c.deadlineMs > 10000 || typeof c.transport !== 'function') return null;
    return u.origin;
  } catch { return null; }
}
export function createStaffEmailMockAdapter(config: Config) {
  const origin = validatedConfig(config);
  async function call(path: string, method: 'GET' | 'POST' | 'PUT', body: unknown, bearer?: string): Promise<{ status: number; data: unknown } | null> {
    if (!origin) return null;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        (async () => {
          const headers: Record<string,string> = { apikey: config.publicKey, 'content-type': 'application/json' };
          if (bearer) headers.authorization = `Bearer ${bearer}`;
          const response = await config.transport(origin + path, { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }), redirect: 'error', signal: controller.signal });
          return { status: response.status, data: await response.json() };
        })(),
        new Promise<null>((resolve) => { timer = setTimeout(() => { controller.abort(); resolve(null); }, config.deadlineMs); }),
      ]);
    } catch { return null; } finally { if (timer) clearTimeout(timer); }
  }
  async function begin(state: TrustedState, password: string): Promise<Result> {
    const rule = assessStaffEmail(state);
    if (!origin || !UUID.test(state.userId) || !password) return 'unavailable';
    if (rule !== 'ready') return rule;
    const current = canonicalStaffEmail(state.current)!, target = normalizeStaffEmail(state.target)!;
    const grant = await call('/auth/v1/token?grant_type=password', 'POST', { email: current, password });
    const g = obj(grant?.data);
    if (!grant || grant.status !== 200 || !g || hasErrorMarkers(g) || typeof g.access_token !== 'string' || !g.access_token.trim() || /[\s\x00-\x1f\x7f]/.test(g.access_token) || (g.user !== undefined && (!obj(g.user) || hasErrorMarkers(obj(g.user)!) || obj(g.user)?.id !== state.userId))) return 'unavailable';
    const bearer = g.access_token;
    const user = await call('/auth/v1/user', 'GET', undefined, bearer);
    if (!user || user.status !== 200 || !obj(user.data) || hasErrorMarkers(obj(user.data)!) || !verifiedUser(user.data, state.userId, current)) return 'unavailable';
    const response = await call('/auth/v1/user', 'PUT', { email: target }, bearer);
    if (!response || response.status !== 200) return response && [400,401,403,422].includes(response.status) ? 'rejected' : 'unknown';
    const updated = obj(response.data);
    return updated && !hasErrorMarkers(updated) && updated.id === state.userId && canonicalEvidence(updated.new_email, target) ? 'pending' : 'unknown';
  }
  async function verify(state: TrustedState, proof: { mailbox: 'current' | 'target'; token: string }): Promise<Result> {
    if (!origin || !UUID.test(state.userId) || !/^[0-9]{1,20}$/.test(proof.token) || !['current','target'].includes(proof.mailbox)) return 'invalid';
    const current = canonicalStaffEmail(state.current), target = canonicalStaffEmail(state.target), pending = canonicalStaffEmail(state.pending);
    if (!current || !target || current === target || !state.pendingUnexpired || !pending || pending !== target || state.privileged.map(canonicalStaffEmail).some((v) => v === null || v === current || v === target)) return 'invalid';
    const response = await call('/auth/v1/verify', 'POST', { type: 'email_change', email: proof.mailbox === 'current' ? current : pending, token: proof.token });
    if (!response || response.status !== 200) return response && [400,401,403,422].includes(response.status) ? 'rejected' : 'unknown';
    const data = obj(response.data);
    if (!data) return 'unknown';
    if (Object.keys(data).length === 2 && data.msg === partialMessage && data.code === '200') return 'partial';
    // Any partial-envelope markers with extra or contradictory fields are ambiguous.
    if (hasErrorMarkers(data)) return 'unknown';
    if (verifiedUser(data.user, state.userId, target)) return 'final_candidate';
    return 'unknown';
  }
  return { begin, verify };
}
