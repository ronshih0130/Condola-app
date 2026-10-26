import { query } from "./db";
import type { SignupConsentMetadata } from "./legal-versions";
import { sendMail, SERVICE_EMAIL } from "./mail";
import { signupConfirmMail } from "./mail-copy";
import { consumeMailAttempt, signupSendBlock } from "./reset-limit";
import {
  classifySignupGenerateLink,
  signupConfirmLink,
  signupConfirmUrl,
  type SignupGenerateLink,
} from "./signup-gotrue";

function auth() {
  const url = (process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL || "").replace(/\/$/, "");
  const service = process.env.SUPABASE_SERVICE_ROLE_KEY || "";
  return { url, service };
}

function pgCode(error: unknown) {
  return typeof error === "object" && error && "code" in error ? String((error as { code?: string }).code) : "";
}

async function verificationCounts(userId: string | null) {
  if (!process.env.DATABASE_URL) return { recent: 0, hour: 0, global: 0 };
  try {
    const row = await query<{ recent: number; hour: number; global: number }>(
      `SELECT
         count(*) FILTER (
           WHERE $1::uuid IS NOT NULL AND user_id = $1::uuid AND created_at > now() - interval '60 seconds'
         )::int AS recent,
         count(*) FILTER (
           WHERE $1::uuid IS NOT NULL AND user_id = $1::uuid AND created_at > now() - interval '60 minutes'
         )::int AS hour,
         count(*) FILTER (WHERE created_at > now() - interval '60 minutes')::int AS global
       FROM signup_verifications`,
      [userId],
    );
    const counts = row.rows[0];
    return {
      recent: Number(counts?.recent) || 0,
      hour: Number(counts?.hour) || 0,
      global: Number(counts?.global) || 0,
    };
  } catch (error) {
    if (pgCode(error) === "42P01" || pgCode(error) === "42703") return { recent: 0, hour: 0, global: 0 };
    return null;
  }
}

/**
 * Per-email window, then the project brake, then the shared IP budget.
 * A wait or cap does not consume an IP slot.
 */
export async function gateSignupMail(
  userId: string | null,
  email: string,
  ip: string | null | undefined,
): Promise<"ok" | "wait" | "capped"> {
  const counts = await verificationCounts(userId);
  if (!counts) {
    console.warn("signup mail failed limit");
    return "capped";
  }
  const block = signupSendBlock(counts);
  if (block === "capped") {
    console.warn("signup mail global cap");
    return "capped";
  }
  if (block === "wait") return "wait";
  const allowed = await consumeMailAttempt("signup", email, ip);
  return allowed ? "ok" : "wait";
}

/** Admin generate_link creates or rotates the confirmation token and does not send mail. */
export async function createSignupLink(input: {
  email: string;
  password?: string;
  data?: SignupConsentMetadata;
  origin: string;
}): Promise<SignupGenerateLink> {
  const { url, service } = auth();
  if (!url || !service) return { ok: false, error: "unavailable" };
  const body: Record<string, unknown> = {
    type: "signup",
    email: input.email,
    redirect_to: signupConfirmUrl(input.origin),
  };
  if (input.password) body.password = input.password;
  if (input.data) body.data = input.data;
  try {
    const response = await fetch(`${url}/auth/v1/admin/generate_link`, {
      method: "POST",
      headers: {
        apikey: service,
        Authorization: `Bearer ${service}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });
    return classifySignupGenerateLink(response.status, await response.json().catch(() => ({})));
  } catch {
    return { ok: false, error: "unavailable" };
  }
}

export async function deliverSignupMail(email: string, hashedToken: string, origin: string) {
  const rendered = signupConfirmMail(signupConfirmLink(origin, hashedToken));
  const sent = await sendMail({
    to: email,
    subject: rendered.subject,
    text: rendered.text,
    html: rendered.html,
    replyTo: SERVICE_EMAIL,
  });
  if (!sent.ok) console.warn(`signup mail failed ${sent.reason}`);
  return sent.ok;
}
