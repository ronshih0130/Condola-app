import { query } from "./db";

export const PASSWORD_RESET_EMAIL_LIMIT = 5;
export const PASSWORD_RESET_IP_LIMIT = 20;
export const SIGNUP_MAIL_HOUR_LIMIT = 5;
/** Refuse once this many signup_verifications rows already exist in the last hour. */
export const SIGNUP_MAIL_GLOBAL_LIMIT = 200;

type Attempt = { email: string; ip: string; at: number };

const memory: Attempt[] = [];

export function underResetLimit(emailCount: number, ipCount: number, ip: string) {
  if (emailCount >= PASSWORD_RESET_EMAIL_LIMIT) return false;
  if (ip && ipCount >= PASSWORD_RESET_IP_LIMIT) return false;
  return true;
}

/** Per-email window, then the project brake. Callers apply the shared IP budget separately. */
export function signupSendBlock(input: { recent: number; hour: number; global: number }): "ok" | "wait" | "capped" {
  if (input.recent > 0 || input.hour >= SIGNUP_MAIL_HOUR_LIMIT) return "wait";
  if (input.global > SIGNUP_MAIL_GLOBAL_LIMIT) return "capped";
  return "ok";
}

function missingRelation(error: unknown) {
  const code = typeof error === "object" && error && "code" in error ? String((error as { code?: string }).code) : "";
  return code === "42P01" || code === "42703";
}

function consumeMemory(email: string, ip: string, now = Date.now()) {
  const windowStart = now - 60 * 60 * 1000;
  const recent = memory.filter((row) => row.at > windowStart);
  memory.length = 0;
  memory.push(...recent);
  const emailCount = recent.filter((row) => row.email === email).length;
  const ipCount = ip ? recent.filter((row) => row.ip === ip).length : 0;
  if (!underResetLimit(emailCount, ipCount, ip)) return false;
  memory.push({ email, ip, at: now });
  return true;
}

async function consumeDatabase(email: string, ip: string) {
  await query(`DELETE FROM password_reset_attempts WHERE created_at < now() - interval '2 days'`);
  const inserted = await query<{ inserted: number }>(
    `WITH ins AS (
       INSERT INTO password_reset_attempts (email_key, ip_key)
       SELECT $1, $2
        WHERE (
          SELECT count(*) FROM password_reset_attempts
           WHERE email_key = $1 AND created_at > now() - interval '60 minutes'
        ) < $3
          AND (
            $2 = '' OR (
              SELECT count(*) FROM password_reset_attempts
               WHERE ip_key = $2 AND created_at > now() - interval '60 minutes'
            ) < $4
          )
       RETURNING 1
     )
     SELECT count(*)::int AS inserted FROM ins`,
    [email, ip, PASSWORD_RESET_EMAIL_LIMIT, PASSWORD_RESET_IP_LIMIT],
  );
  return inserted.rows[0]?.inserted === 1;
}

async function consumeAttempt(emailKey: string, ip: string | null | undefined, logLabel: string) {
  const address = (ip ?? "").trim();
  if (!process.env.DATABASE_URL) return consumeMemory(emailKey, address);
  try {
    return await consumeDatabase(emailKey, address);
  } catch (error) {
    if (!missingRelation(error)) {
      console.error(logLabel, error instanceof Error ? error.message : "failed");
    }
    return consumeMemory(emailKey, address);
  }
}

/** Same response either way. A missing table falls back to this isolate's memory. */
export async function consumePasswordReset(email: string, ip: string | null | undefined) {
  return consumeAttempt(email, ip, "password reset limit");
}

/** IP budget is shared with password resets. email_key is prefixed so the email counters stay separate. */
export async function consumeMailAttempt(scope: string, email: string, ip: string | null | undefined) {
  const name = scope.trim();
  const emailKey = name ? `${name}:${email}` : email;
  return consumeAttempt(emailKey, ip, "mail attempt limit");
}
