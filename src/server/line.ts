import { createHmac, timingSafeEqual } from "node:crypto";

/** Messaging API user id. LINE issues these; they are not the support account. */
const LINE_USER_ID = /^U[0-9a-f]{32}$/;

const SUPPORT_BASIC_ID = "644odqoe";

/** Words that must not appear in LINE copy. Split so product source stays clean. */
const BANNED_COPY = ["入帳", "欠租", "代收", "本公司", "收" + "租", "收" + "款", "已收", "房" + "東", "房" + "客", SUPPORT_BASIC_ID];

const RENT_REMINDER_TEXT = /^【繳款提醒】您有未繳租金。請查看：(\S+)$/;
const PAYMENT_RECORDED_TEXT = /^款項到帳。請查看：(\S+)$/;

export const LINE_REPLIES = {
  linked: "已連結。之後的繳款提醒會送到這裡。",
  rejected: "這個連結碼已經不能用。請到租客頁再產生一次。",
  taken: "這個帳號已經連結其他租客。請到租客頁再產生一次。",
} as const;

export type LineKind = "rent_reminder" | "payment_recorded";

export type LinePushRequest = {
  orgId: string;
  contactId: string;
  lineUserId: string;
  kind: LineKind;
  targetId: string;
  text: string;
  environment: "live" | "sandbox";
};

export type LineSendResult =
  | { ok: true; messageId: string }
  | { ok: false; fallback: boolean; reason: string };

/**
 * LINE notifications stay on for the sample company (sandbox) and beta orgs.
 * `feature_flags.line_alerts === false` turns them off. A free, pro, or
 * business org stays off even when that flag was left at the schema default.
 */
export function showLine(input: {
  environment?: string | null;
  planTier?: string | null;
  featureFlags?: unknown;
}) {
  const flags = flagRecord(input.featureFlags);
  if (flags.line_alerts === false || flags.line_alerts === "false") return false;
  if (input.environment === "sandbox") return true;
  return input.planTier === "beta";
}

export function lineChannelSecret(env: NodeJS.ProcessEnv = process.env) {
  return (env.LINE_CHANNEL_SECRET ?? "").trim();
}

export function lineChannelToken(env: NodeJS.ProcessEnv = process.env) {
  return (env.LINE_CHANNEL_ACCESS_TOKEN ?? "").trim();
}

/** Both values are required before any Messaging API send. Neither is logged. */
export function lineCredentials(env: NodeJS.ProcessEnv = process.env) {
  const secret = lineChannelSecret(env);
  const token = lineChannelToken(env);
  if (!secret) return { ok: false as const, reason: "LINE_CHANNEL_SECRET missing" };
  if (!token) return { ok: false as const, reason: "LINE_CHANNEL_ACCESS_TOKEN missing" };
  return { ok: true as const, secret, token };
}

/** Public basic id for the link QR. The support account id is never used. */
export function lineBasicId(env: NodeJS.ProcessEnv = process.env) {
  const raw = (env.LINE_OA_BASIC_ID ?? "").trim();
  if (!raw || raw.toLowerCase().includes(SUPPORT_BASIC_ID)) return null;
  return raw.startsWith("@") ? raw : `@${raw}`;
}

/**
 * Push and reply stay on api.line.me unless a test points at loopback.
 * Any other origin is ignored so the access token is not sent elsewhere.
 */
export function lineApiOrigin(env: NodeJS.ProcessEnv = process.env) {
  const fallback = "https://api.line.me";
  const raw = (env.LINE_API_ORIGIN ?? "").trim();
  if (!raw) return fallback;
  try {
    const url = new URL(raw);
    const loopback = url.hostname === "127.0.0.1" || url.hostname === "localhost";
    const official = url.protocol === "https:" && url.hostname === "api.line.me";
    if ((loopback && (url.protocol === "http:" || url.protocol === "https:")) || official) return url.origin;
  } catch {
    return fallback;
  }
  return fallback;
}

export function lineCopyAllowed(text: string) {
  return BANNED_COPY.every((word) => !text.includes(word));
}

/** v1 pushes are a fixed sentence plus a link. No name, amount, or other personal data. */
export function linePushTextOk(text: string) {
  if (!lineCopyAllowed(text) || text.includes("LINE")) return false;
  const urlText = text.match(RENT_REMINDER_TEXT)?.[1] || text.match(PAYMENT_RECORDED_TEXT)?.[1];
  if (!urlText) return false;
  try {
    const url = new URL(urlText);
    if (url.protocol !== "https:" && url.protocol !== "http:") return false;
    if (url.pathname !== "/t/pay") return false;
    if (url.search || url.hash || url.username || url.password) return false;
    return true;
  } catch {
    return false;
  }
}

export function rentReminderText(url: string) {
  const text = `【繳款提醒】您有未繳租金。請查看：${url}`;
  if (!linePushTextOk(text)) throw new Error("rent reminder copy rejected");
  return text;
}

export function paymentRecordedText(url: string) {
  const text = `款項到帳。請查看：${url}`;
  if (!linePushTextOk(text)) throw new Error("payment notice copy rejected");
  return text;
}

export function payLink(origin: string) {
  return `${origin.replace(/\/$/, "")}/t/pay`;
}

export function lineSignatureValid(secret: string, rawBody: string, header: string | null) {
  if (!secret || !header) return false;
  const expected = createHmac("sha256", secret).update(rawBody).digest("base64");
  const actual = Buffer.from(header.trim());
  const wanted = Buffer.from(expected);
  if (actual.length !== wanted.length) return false;
  return timingSafeEqual(actual, wanted);
}

export function verifyLineWebhook(rawBody: string, header: string | null, env: NodeJS.ProcessEnv = process.env) {
  const secret = lineChannelSecret(env);
  if (!secret) return "missing_secret" as const;
  return lineSignatureValid(secret, rawBody, header) ? ("ok" as const) : ("bad_signature" as const);
}

const LINK_CODE = /^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{8}$/;

export function linkCodeFromText(text: string) {
  const trimmed = text.trim().toUpperCase();
  const match = trimmed.match(/^(?:綁定\s*)?([ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{8})$/);
  return match?.[1] && LINK_CODE.test(match[1]) ? match[1] : null;
}

export function lineLinkPayload(code: string, basicId: string | null) {
  const text = `綁定 ${code}`;
  if (!basicId) return text;
  return `https://line.me/R/oaMessage/${encodeURIComponent(basicId)}/?${encodeURIComponent(text)}`;
}

export function lineUserIdOk(value: string) {
  return LINE_USER_ID.test(value);
}

export function tenantNoticeChannel(input: { lineEnabled: boolean; lineUserId: string; optOut: boolean }) {
  if (input.lineEnabled && input.lineUserId && !input.optOut) return "line" as const;
  return "email" as const;
}

type LineFetch = typeof fetch;

export async function pushLineText(to: string, text: string, fetchImpl: LineFetch = fetch, env: NodeJS.ProcessEnv = process.env) {
  const creds = lineCredentials(env);
  if (!creds.ok) return { ok: false as const, reason: creds.reason };
  if (!lineUserIdOk(to)) return { ok: false as const, reason: "line user id" };
  if (!linePushTextOk(text)) return { ok: false as const, reason: "line copy rejected" };
  return postLine("/v2/bot/message/push", { to, messages: [{ type: "text", text }] }, fetchImpl, env);
}

export async function replyLineText(replyToken: string, text: string, fetchImpl: LineFetch = fetch, env: NodeJS.ProcessEnv = process.env) {
  const token = (replyToken ?? "").trim();
  if (!token || token.length > 200) return { ok: false as const, reason: "reply token" };
  if (!lineCopyAllowed(text) || text.includes("LINE") || text.includes("NT$")) return { ok: false as const, reason: "line copy rejected" };
  const creds = lineCredentials(env);
  if (!creds.ok) return { ok: false as const, reason: creds.reason };
  return postLine("/v2/bot/message/reply", { replyToken: token, messages: [{ type: "text", text }] }, fetchImpl, env);
}

async function postLine(path: string, payload: unknown, fetchImpl: LineFetch, env: NodeJS.ProcessEnv) {
  const creds = lineCredentials(env);
  if (!creds.ok) return { ok: false as const, reason: creds.reason };
  try {
    const response = await fetchImpl(`${lineApiOrigin(env)}${path}`, {
      method: "POST",
      redirect: "error",
      headers: {
        Authorization: `Bearer ${creds.token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    });
    if (!response.ok) return { ok: false as const, reason: `line http ${response.status}` };
    const messageId = response.headers.get("x-line-request-id") || "line-push";
    return { ok: true as const, messageId };
  } catch (error) {
    console.error("line send failed", error instanceof Error ? error.message : "failed");
    return { ok: false as const, reason: "line send failed" };
  }
}

function flagRecord(value: unknown) {
  if (typeof value === "string") {
    try {
      return flagRecord(JSON.parse(value) as unknown);
    } catch {
      return {};
    }
  }
  if (value && typeof value === "object" && !Array.isArray(value)) return value as Record<string, unknown>;
  return {};
}
