import { createHmac, timingSafeEqual } from "node:crypto";
import { svc } from "../db";
import { readLineConfig, type LineEnv } from "./config";
import type { LineMessage, LineTransport } from "./transport";

export function verifyLineSignature(raw: Uint8Array, signature: string | null, secret: string): boolean {
  const expected = createHmac("sha256", secret).update(raw).digest();
  // Canonical SHA-256 base64 only. Always compare equal-length buffers, even on malformed input.
  const valid = typeof signature === "string" && /^[A-Za-z0-9+/]{43}=$/.test(signature);
  const supplied = valid ? Buffer.from(signature, "base64") : Buffer.alloc(32);
  return timingSafeEqual(expected, supplied) && valid && supplied.toString("base64") === signature;
}
export function providerUserHash(providerId: string, userId: string, pepper: string): string {
  return createHmac("sha256", pepper).update(JSON.stringify([providerId, userId])).digest("hex");
}
// destination is the OA bot user id, not messaging_channel_id or oa_basic_id.
export type WebhookSecrets = { secret: string; identityPepper: string; destination: string };
export type SecretResolver = (messagingChannelSecretRef: string) => Promise<WebhookSecrets | null>;
type Event = { webhookEventId: string; type: string; timestamp: number; source?: { userId?: string }; replyToken?: string };
function parseEvents(value: unknown, destination: string): Event[] | null {
  if (!value || typeof value !== "object") return null;
  const body = value as { destination?: unknown; events?: unknown };
  if (body.destination !== destination || !Array.isArray(body.events)) return null;
  const events: Event[] = [];
  for (const raw of body.events) {
    if (!raw || typeof raw !== "object") return null;
    const e = raw as Event;
    if (typeof e.webhookEventId !== "string" || e.webhookEventId.length < 1 || e.webhookEventId.length > 200 ||
      typeof e.type !== "string" || !/^[a-zA-Z]{1,50}$/.test(e.type) || !Number.isSafeInteger(e.timestamp) ||
      e.timestamp < 0 || !Number.isFinite(new Date(e.timestamp).getTime()) ||
      (e.source !== undefined && (!e.source || typeof e.source !== "object")) ||
      (e.source?.userId !== undefined && (typeof e.source.userId !== "string" || !/^U[0-9a-f]{32}$/.test(e.source.userId))) ||
      (e.replyToken !== undefined && (typeof e.replyToken !== "string" || e.replyToken.length > 1000))) return null;
    events.push(e);
  }
  return events;
}
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const response = (status: number) => new Response(null, { status, headers: { "Cache-Control": "no-store" } });
/** Server-owned channel/org URL configuration; never trust the body's destination to select a secret. */
export function createWebhookPost(deps: {
  resolveSecret: SecretResolver;
  transport: Pick<LineTransport, "reply">;
  replyMessages?: (eventType: "message" | "postback") => readonly LineMessage[];
  env?: LineEnv;
}) {
  return async function post(request: Request): Promise<Response> {
    if (request.method !== "POST") return response(405);
    if (!readLineConfig(deps.env).platformEnabled) return response(404);
    const url = new URL(request.url), org = url.searchParams.get("org"), channel = url.searchParams.get("channel");
    if (!org || !channel || !uuid.test(org) || !uuid.test(channel)) return response(404);
    try {
      const context = await svc(null, async c => (await c.query<{ messaging_channel_secret_ref: string; line_provider_id: string }>(
        `SELECT messaging_channel_secret_ref,line_provider_id FROM public.line_channels
         WHERE id=$2 AND id=app.b033_selected_channel($1)`, [org, channel])).rows[0]);
      if (!context) return response(404);
      const secrets = await deps.resolveSecret(context.messaging_channel_secret_ref);
      if (!secrets?.secret || !secrets.identityPepper || !secrets.destination) return response(503);
      const raw = Buffer.from(await request.arrayBuffer());
      if (!verifyLineSignature(raw, request.headers.get("x-line-signature"), secrets.secret)) return response(401);
      let body: unknown;
      try { body = JSON.parse(raw.toString("utf8")); } catch { return response(400); }
      const events = parseEvents(body, secrets.destination);
      if (!events) return response(400);
      // Recheck flags and hold their locks through the entire persistence transaction.
      const applied = await svc(null, async c => {
        if ((await c.query("SELECT app.b033_selected_channel($1) AS id", [org])).rows[0].id !== channel) return null;
        const fresh: Event[] = [];
        for (const e of events) {
          const hash = e.source?.userId ? providerUserHash(context.line_provider_id, e.source.userId, secrets.identityPepper) : null;
          const friend = e.type === "follow" ? true : e.type === "unfollow" ? false : null;
          const r = await c.query("SELECT app.b033_webhook_record($1,$2,$3,$4,$5,$6) AS applied",
            [channel, e.webhookEventId, e.type, new Date(e.timestamp), hash, friend]);
          if (r.rows[0].applied) fresh.push(e);
        }
        return fresh;
      });
      if (!applied) return response(404);
      for (const e of applied) {
        if ((e.type === "message" || e.type === "postback") && e.replyToken) {
          const messages = deps.replyMessages?.(e.type) ?? [];
          if (messages.length) {
            // Expired/used tokens or unknown outcomes terminate here. No push capability in this call chain.
            try { await deps.transport.reply(e.replyToken, messages); } catch { /* No retry or push. */ }
          }
        }
      }
      return response(200);
    } catch { return response(503); } // Never log raw DB/provider errors or private webhook material.
  };
}
