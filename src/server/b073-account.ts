import { guardEffectiveSession } from "./b017-custom-role-governance";
import { logServerError } from "./errors";
import type { StaffProfileView } from "./staff-profile";
import type { Session } from "./types";

/**
 * B-073 / R5-ACCT (設定 › 我的帳號, MGT-137). A presentation read over today's account functions; nothing here
 * writes, and no auth function changes. Every value is the caller's own (user id from the session, never input):
 * - phone: `profiles.phone_e164`, masked inside the database before it leaves (09xx-•••-xxx for a Taiwan mobile,
 *   •••-•••-xxx for any other number with at least 8 digits, •••-•••-••• otherwise); no number → the row is omitted;
 * - LINE: `profiles.line_linked`, the demo staff LINE Login's link. Shown only where that sign-in is shown — the login
 *   page's own gate (`showDemoLineCopy` for this firm's environment and `lineLoginEnabled`): never for a live firm, never
 *   in a production-like env. Elsewhere the row is omitted. Google: the app has no staff Google sign-in, so the row
 *   is always omitted;
 * - two-step verification: `mfaStatus`; signed-in devices: `listSessions` (the same rows today's page lists);
 * - the display-name form state: `staffProfileView`; an enrollment in progress: `peekChallenge` (as today).
 * The password's last-change date is not stored anywhere, so it is not read.
 */
export type AccountDevice = { id: string; userAgent: string | null; ip: string | null };
export type AccountChallenge = { secret: string | null; otpauth: string | null };
export type AccountRead =
  | { state: "unavailable" }
  | {
      state: "ready";
      phone: string | null;
      /** null = the app has no staff LINE Login here; the row is omitted. */
      line: boolean | null;
      mfa: { enabled: boolean; required: boolean };
      devices: AccountDevice[];
      profile: StaffProfileView;
      challenge: AccountChallenge | null;
    };

/** The only shapes a masked phone may take; a full number can never render. */
export const ACCOUNT_PHONE_MASK = /^(?:09[0-9]{2}-•••-[0-9]{3}|•••-•••-(?:[0-9]{3}|•••))$/;

type Own = { phone: string | null; line: boolean };
async function readOwn(userId: string): Promise<Own> {
  const { query } = await import("./db");
  const row = (await query<{ phone_masked: string | null; line_linked: boolean | null }>(
    `SELECT CASE
              WHEN nullif(btrim(phone_e164), '') IS NULL THEN NULL
              WHEN phone_e164 ~ '^\\+8869[0-9]{8}$' THEN '09' || substr(phone_e164, 6, 2) || '-•••-' || right(phone_e164, 3)
              WHEN length(regexp_replace(phone_e164, '[^0-9]', '', 'g')) >= 8
                THEN '•••-•••-' || right(regexp_replace(phone_e164, '[^0-9]', '', 'g'), 3)
              ELSE '•••-•••-•••' END AS phone_masked,
            line_linked
       FROM profiles WHERE id = $1`,
    [userId],
  )).rows[0];
  // No profile row: no phone, LINE not linked (the column default).
  return { phone: row?.phone_masked ?? null, line: row?.line_linked === true };
}
async function readMfa(userId: string) { return (await import("./auth")).mfaStatus(userId); }
async function readDevices(userId: string): Promise<AccountDevice[]> {
  const rows = await (await import("./auth")).listSessions(userId);
  return rows.map(row => ({ id: row.id, userAgent: row.user_agent, ip: row.ip }));
}
async function readProfile(session: Session): Promise<StaffProfileView> {
  // Today's page reads the name form only for a live staff session.
  if (session.kind !== "staff" || session.environment !== "live") return { state: "unavailable" };
  return (await import("./staff-profile")).staffProfileView(session);
}
async function readChallenge(id: string): Promise<AccountChallenge | null> {
  const challenge = await (await import("./auth")).peekChallenge(id);
  return challenge ? { secret: challenge.secret, otpauth: challenge.otpauth } : null;
}
async function lineSupported(session: Session) {
  const demo = await import("./demo");
  return session.kind === "staff" && demo.showDemoLineCopy(session.environment) && demo.lineLoginEnabled();
}

type Deps = {
  readOwn?: typeof readOwn; readMfa?: typeof readMfa; readDevices?: typeof readDevices; readProfile?: typeof readProfile;
  readChallenge?: typeof readChallenge; lineSupported?: (session: Session) => boolean | Promise<boolean>;
};

/**
 * The page reader (all staff roles; each sees only their own account). `challengeId` is today's enrollment cookie,
 * read only when the page was sent back with `?enroll=1`, exactly as today. Any failure → unavailable (read error).
 */
export async function accountRead(session: Session, options: { challengeId?: string } = {}, deps: Deps = {}): Promise<AccountRead> {
  try {
    session = await guardEffectiveSession(session, null);
    const [own, mfa, devices, profile, challenge, line] = await Promise.all([
      (deps.readOwn ?? readOwn)(session.userId),
      (deps.readMfa ?? readMfa)(session.userId),
      (deps.readDevices ?? readDevices)(session.userId),
      (deps.readProfile ?? readProfile)(session),
      options.challengeId !== undefined ? (deps.readChallenge ?? readChallenge)(options.challengeId) : Promise.resolve(null),
      (deps.lineSupported ?? lineSupported)(session),
    ]);
    if (own.phone !== null && !ACCOUNT_PHONE_MASK.test(own.phone)) throw new Error("Unmasked phone");
    return {
      state: "ready", phone: own.phone, line: line ? own.line : null,
      mfa: { enabled: mfa.enabled === true, required: mfa.required === true }, devices, profile, challenge,
    };
  } catch (error) {
    logServerError("b073_account_read", error);
    return { state: "unavailable" };
  }
}
