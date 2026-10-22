import { randomBytes } from "node:crypto";
import type { Client } from "pg";
import { writeAudit } from "./audit";
import { query, withClient } from "./db";
import { paymentRecordedMail } from "./mail-copy";
import { replyToAddress, sendMail } from "./mail";
import { publicSiteOrigin } from "./signup-gotrue";
import { canSendReal, SANDBOX_NOT_SENT } from "./outbound";
import type { Session } from "./types";
import {
  LINE_REPLIES,
  lineBasicId,
  lineCredentials,
  lineLinkPayload,
  linePushTextOk,
  lineUserIdOk,
  linkCodeFromText,
  payLink,
  paymentRecordedText,
  pushLineText,
  replyLineText,
  showLine,
  verifyLineWebhook,
  type LineKind,
  type LinePushRequest,
  type LineSendResult,
} from "./line";

const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

export type TenantLinePanel = {
  showLine: boolean;
  sandbox: boolean;
  linked: boolean;
  optOut: boolean;
  code: string | null;
  qrSvg: string | null;
};

const EMPTY_PANEL: TenantLinePanel = {
  showLine: false,
  sandbox: false,
  linked: false,
  optOut: false,
  code: null,
  qrSvg: null,
};

type ContactLine = {
  contactId: string;
  orgId: string;
  environment: "live" | "sandbox";
  planTier: string;
  featureFlags: unknown;
  optOut: boolean;
  lineUserId: string;
  email: string;
  name: string;
  orgName: string;
  contactEmail: string | null;
  userId: string | null;
  showLine: boolean;
};

function missingRelation(error: unknown) {
  const code = typeof error === "object" && error && "code" in error ? String((error as { code?: string }).code) : "";
  return code === "42P01" || code === "42703";
}

function pgCode(error: unknown) {
  return typeof error === "object" && error && "code" in error ? String((error as { code?: string }).code) : "";
}

function newLinkCode() {
  const bytes = randomBytes(8);
  let code = "";
  for (const byte of bytes) code += CODE_ALPHABET[byte % CODE_ALPHABET.length];
  return code;
}

async function loadContact(session: Session): Promise<ContactLine | null> {
  if (session.kind !== "tenant") return null;
  const row = await query<{
    contact_id: string;
    environment: string;
    plan_tier: string;
    feature_flags: unknown;
    opt_out: boolean;
    line_user_id: string | null;
    email: string | null;
    name: string;
    org_name: string;
    contact_email: string | null;
    user_id: string | null;
  }>(
    `SELECT c.id::text AS contact_id,
            o.environment::text AS environment,
            o.plan_tier::text AS plan_tier,
            o.feature_flags,
            c.line_notify_opt_out AS opt_out,
            c.display_name AS name,
            c.email::text AS email,
            c.user_id::text AS user_id,
            o.name AS org_name,
            o.contact_email::text AS contact_email,
            (
              SELECT ll.line_user_id
                FROM line_account_links ll
               WHERE ll.contact_id = c.id
                 AND ll.org_id = c.org_id
                 AND ll.status = 'linked'
               ORDER BY ll.linked_at DESC NULLS LAST
               LIMIT 1
            ) AS line_user_id
       FROM contacts c
       JOIN organizations o ON o.id = c.org_id
      WHERE c.user_id = $1
        AND c.org_id = $2
        AND c.is_tenant
        AND c.archived_at IS NULL
      LIMIT 1`,
    [session.userId, session.orgId],
  );
  const found = row.rows[0];
  if (!found) return null;
  const environment = found.environment === "sandbox" ? "sandbox" : "live";
  const enabled = showLine({ environment, planTier: found.plan_tier, featureFlags: found.feature_flags });
  return {
    contactId: found.contact_id,
    orgId: session.orgId,
    environment,
    planTier: found.plan_tier,
    featureFlags: found.feature_flags,
    optOut: found.opt_out === true,
    lineUserId: found.line_user_id && lineUserIdOk(found.line_user_id) ? found.line_user_id : "",
    email: (found.email ?? "").trim(),
    name: (found.name ?? "").trim(),
    orgName: found.org_name,
    contactEmail: found.contact_email,
    userId: found.user_id,
    showLine: enabled,
  };
}

async function qrSvg(payload: string) {
  try {
    const mod = (await import("qrcode")) as {
      default?: { toString: QrToString };
      toString?: QrToString;
    };
    const qr = mod.default?.toString ? mod.default : mod;
    if (!qr.toString) return null;
    const svg = await new Promise<string>((resolve, reject) => {
      qr.toString?.(payload, { type: "svg", margin: 1, errorCorrectionLevel: "M" }, (error, value) => {
        if (error) reject(error);
        else resolve(value);
      });
    });
    if (!svg.includes("<svg") || svg.includes("<script")) return null;
    return svg.replace(/<\?xml[^>]*>/, "").trim();
  } catch {
    return null;
  }
}

type QrToString = (
  text: string,
  options: object,
  callback: (error: Error | null | undefined, value: string) => void,
) => void;

export async function loadTenantLinePanel(session: Session): Promise<TenantLinePanel> {
  try {
    const contact = await loadContact(session);
    if (!contact?.showLine) return EMPTY_PANEL;
    const codeRow = await query<{ code: string }>(
      `SELECT code
         FROM line_link_codes
        WHERE org_id = $1
          AND contact_id = $2
          AND used_at IS NULL
          AND expires_at > now()
        ORDER BY created_at DESC
        LIMIT 1`,
      [contact.orgId, contact.contactId],
    );
    const code = codeRow.rows[0]?.code ?? null;
    const qr = code ? await qrSvg(lineLinkPayload(code, lineBasicId())) : null;
    return {
      showLine: true,
      sandbox: !canSendReal(contact.environment),
      linked: Boolean(contact.lineUserId),
      optOut: contact.optOut,
      code,
      qrSvg: qr,
    };
  } catch (error) {
    if (missingRelation(error)) return EMPTY_PANEL;
    throw error;
  }
}

export async function issueLineLinkCode(session: Session) {
  const contact = await loadContact(session);
  if (!contact?.showLine) return false;
  await query(
    `UPDATE line_link_codes
        SET used_at = now()
      WHERE org_id = $1 AND contact_id = $2 AND used_at IS NULL`,
    [contact.orgId, contact.contactId],
  );
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const code = newLinkCode();
    try {
      await query(
        `INSERT INTO line_link_codes (org_id, contact_id, code, expires_at)
         VALUES ($1, $2, $3, now() + interval '30 minutes')`,
        [contact.orgId, contact.contactId, code],
      );
      return true;
    } catch (error) {
      if (pgCode(error) !== "23505") throw error;
    }
  }
  return false;
}

export async function setLineOptOut(session: Session, optOut: boolean) {
  const contact = await loadContact(session);
  if (!contact?.showLine) return false;
  await query(
    `UPDATE contacts
        SET line_notify_opt_out = $3, updated_at = now()
      WHERE id = $1 AND org_id = $2 AND user_id = $4 AND is_tenant`,
    [contact.contactId, contact.orgId, optOut, session.userId],
  );
  return true;
}

type LogWrite = {
  orgId: string;
  contactId: string;
  kind: LineKind;
  targetId: string;
  lineUserId: string | null;
  body: string;
  status: "sent" | "failed" | "skipped";
  providerMessageId: string | null;
  error: string | null;
};

async function writeLog(input: LogWrite) {
  const error = input.error ? input.error.slice(0, 200) : null;
  await query(
    `INSERT INTO line_delivery_log (
       org_id, contact_id, kind, target_id, line_user_id, body, status, attempt,
       provider_message_id, error, next_retry_at, sent_at
     ) VALUES (
       $1, $2, $3, $4, $5, $6, $7,
       CASE WHEN $7 = 'failed' THEN 1 ELSE 0 END,
       $8, $9,
       CASE WHEN $7 = 'failed' THEN now() + interval '15 minutes' ELSE NULL END,
       CASE WHEN $7 = 'sent' THEN now() ELSE NULL END
     )
     ON CONFLICT (org_id, kind, target_id, contact_id)
     DO UPDATE SET
       line_user_id = EXCLUDED.line_user_id,
       body = EXCLUDED.body,
       status = EXCLUDED.status,
       attempt = CASE
         WHEN EXCLUDED.status = 'failed' THEN line_delivery_log.attempt + 1
         ELSE line_delivery_log.attempt
       END,
       provider_message_id = COALESCE(EXCLUDED.provider_message_id, line_delivery_log.provider_message_id),
       error = EXCLUDED.error,
       next_retry_at = CASE WHEN EXCLUDED.status = 'failed' THEN now() + interval '15 minutes' ELSE NULL END,
       sent_at = CASE WHEN EXCLUDED.status = 'sent' THEN now() ELSE line_delivery_log.sent_at END
     WHERE line_delivery_log.status IS DISTINCT FROM 'sent'`,
    [
      input.orgId,
      input.contactId,
      input.kind,
      input.targetId,
      input.lineUserId,
      input.body,
      input.status,
      input.providerMessageId,
      error,
    ],
  );
}

async function existingLog(input: Pick<LogWrite, "orgId" | "kind" | "targetId" | "contactId">) {
  const row = await query<{
    status: string;
    attempt: number;
    provider_message_id: string | null;
    next_retry_at: Date | null;
  }>(
    `SELECT status, attempt, provider_message_id, next_retry_at
       FROM line_delivery_log
      WHERE org_id = $1 AND kind = $2 AND target_id = $3 AND contact_id = $4`,
    [input.orgId, input.kind, input.targetId, input.contactId],
  );
  return row.rows[0] ?? null;
}

async function linkedUser(contactId: string, orgId: string) {
  const row = await query<{
    opt_out: boolean;
    line_user_id: string | null;
    environment: string;
    plan_tier: string;
    feature_flags: unknown;
  }>(
    `SELECT c.line_notify_opt_out AS opt_out,
            o.environment::text AS environment,
            o.plan_tier::text AS plan_tier,
            o.feature_flags,
            (
              SELECT ll.line_user_id
                FROM line_account_links ll
               WHERE ll.contact_id = c.id AND ll.org_id = c.org_id AND ll.status = 'linked'
               ORDER BY ll.linked_at DESC NULLS LAST
               LIMIT 1
            ) AS line_user_id
       FROM contacts c
       JOIN organizations o ON o.id = c.org_id
      WHERE c.id = $1 AND c.org_id = $2`,
    [contactId, orgId],
  );
  return row.rows[0] ?? null;
}

export async function deliverTenantLine(input: LinePushRequest): Promise<LineSendResult> {
  try {
    if (!canSendReal(input.environment)) {
      await writeLog({
        orgId: input.orgId,
        contactId: input.contactId,
        kind: input.kind,
        targetId: input.targetId,
        lineUserId: lineUserIdOk(input.lineUserId) ? input.lineUserId : null,
        body: input.text,
        status: "skipped",
        providerMessageId: null,
        error: SANDBOX_NOT_SENT,
      });
      return { ok: false, fallback: false, reason: "sandbox" };
    }
    const existing = await existingLog(input);
    if (existing?.status === "sent") return { ok: true, messageId: existing.provider_message_id || "line-push" };
    if (existing?.status === "failed" && Number(existing.attempt) >= 3) {
      return { ok: false, fallback: false, reason: "gave up" };
    }
    if (existing?.status === "failed" && existing.next_retry_at && new Date(existing.next_retry_at).getTime() > Date.now()) {
      return { ok: false, fallback: false, reason: "waiting" };
    }
    const current = await linkedUser(input.contactId, input.orgId);
    const enabled = current
      ? showLine({ environment: current.environment, planTier: current.plan_tier, featureFlags: current.feature_flags })
      : false;
    const lineUserId = current?.line_user_id && lineUserIdOk(current.line_user_id) ? current.line_user_id : "";
    if (!current || !enabled || current.opt_out || !lineUserId) {
      if (existing && existing.status !== "sent") {
        await writeLog({
          orgId: input.orgId,
          contactId: input.contactId,
          kind: input.kind,
          targetId: input.targetId,
          lineUserId: lineUserId || null,
          body: input.text,
          status: "skipped",
          providerMessageId: null,
          error: current?.opt_out ? "opt_out" : "not_linked",
        });
      }
      return { ok: false, fallback: true, reason: current?.opt_out ? "opt_out" : "not_linked" };
    }
    if (!linePushTextOk(input.text)) {
      await writeLog({
        orgId: input.orgId,
        contactId: input.contactId,
        kind: input.kind,
        targetId: input.targetId,
        lineUserId,
        body: input.text,
        status: "skipped",
        providerMessageId: null,
        error: "line copy rejected",
      });
      return { ok: false, fallback: false, reason: "line copy rejected" };
    }
    const creds = lineCredentials();
    if (!creds.ok) {
      await writeLog({
        orgId: input.orgId,
        contactId: input.contactId,
        kind: input.kind,
        targetId: input.targetId,
        lineUserId,
        body: input.text,
        status: "skipped",
        providerMessageId: null,
        error: creds.reason,
      });
      return { ok: false, fallback: true, reason: creds.reason };
    }
    const sent = await pushLineText(lineUserId, input.text);
    if (!sent.ok) {
      await writeLog({
        orgId: input.orgId,
        contactId: input.contactId,
        kind: input.kind,
        targetId: input.targetId,
        lineUserId,
        body: input.text,
        status: "failed",
        providerMessageId: null,
        error: sent.reason,
      });
      return { ok: false, fallback: false, reason: sent.reason };
    }
    await writeLog({
      orgId: input.orgId,
      contactId: input.contactId,
      kind: input.kind,
      targetId: input.targetId,
      lineUserId,
      body: input.text,
      status: "sent",
      providerMessageId: sent.messageId,
      error: null,
    });
    return { ok: true, messageId: sent.messageId };
  } catch (error) {
    if (missingRelation(error)) return { ok: false, fallback: true, reason: "line log missing" };
    console.error("line delivery", error instanceof Error ? error.message : "failed");
    return { ok: false, fallback: false, reason: "line delivery failed" };
  }
}

export async function retryFailedLinePushes() {
  if (!lineCredentials().ok) return 0;
  try {
    const rows = await query<{
      org_id: string;
      contact_id: string;
      kind: string;
      target_id: string;
      line_user_id: string | null;
      body: string;
    }>(
      `SELECT org_id::text, contact_id::text, kind, target_id::text, line_user_id, body
         FROM line_delivery_log
        WHERE status = 'failed'
          AND attempt < 3
          AND (next_retry_at IS NULL OR next_retry_at <= now())
        ORDER BY created_at
        LIMIT 25`,
    );
    let sent = 0;
    for (const row of rows.rows) {
      if (row.kind !== "rent_reminder" && row.kind !== "payment_recorded") continue;
      const result = await deliverTenantLine({
        orgId: row.org_id,
        contactId: row.contact_id,
        lineUserId: row.line_user_id ?? "",
        kind: row.kind,
        targetId: row.target_id,
        text: row.body,
        environment: "live",
      });
      if (result.ok) sent += 1;
    }
    return sent;
  } catch (error) {
    if (missingRelation(error)) return 0;
    throw error;
  }
}

async function sendPaymentEmail(input: { email: string; name: string; orgName: string; contactEmail: string | null }) {
  if (!input.email) return;
  const rendered = paymentRecordedMail({
    name: input.name || "租客",
    company: input.orgName,
    url: payLink(publicSiteOrigin("")),
  });
  await sendMail({
    to: input.email,
    subject: rendered.subject,
    text: rendered.text,
    html: rendered.html,
    replyTo: replyToAddress(input.contactEmail),
  });
}

/** Real payment notices for beta orgs and the sample company. Returns false to keep the legacy log. */
export async function paymentLineHandled(leaseId: string) {
  try {
    const row = await query<{
      payment_id: string;
      org_id: string;
      environment: string;
      plan_tier: string;
      feature_flags: unknown;
      contact_id: string;
      opt_out: boolean;
      line_user_id: string | null;
      email: string | null;
      name: string;
      org_name: string;
      contact_email: string | null;
      user_id: string | null;
    }>(
      `SELECT p.id::text AS payment_id,
              p.org_id::text AS org_id,
              o.environment::text AS environment,
              o.plan_tier::text AS plan_tier,
              o.feature_flags,
              c.id::text AS contact_id,
              c.line_notify_opt_out AS opt_out,
              c.display_name AS name,
              c.email::text AS email,
              c.user_id::text AS user_id,
              o.name AS org_name,
              o.contact_email::text AS contact_email,
              (
                SELECT ll.line_user_id
                  FROM line_account_links ll
                 WHERE ll.contact_id = c.id AND ll.org_id = c.org_id AND ll.status = 'linked'
                 ORDER BY ll.linked_at DESC NULLS LAST
                 LIMIT 1
              ) AS line_user_id
         FROM payments p
         JOIN organizations o ON o.id = p.org_id
         JOIN lease_parties lp ON lp.lease_id = p.lease_id AND lp.role = 'primary'
         JOIN contacts c ON c.id = lp.contact_id
        WHERE p.lease_id = $1 AND p.status = 'confirmed'
        ORDER BY p.confirmed_at DESC NULLS LAST, p.created_at DESC
        LIMIT 1`,
      [leaseId],
    );
    const found = row.rows[0];
    const environment = found?.environment === "sandbox" ? "sandbox" : "live";
    if (!found || !showLine({ environment, planTier: found.plan_tier, featureFlags: found.feature_flags })) return false;
    const text = paymentRecordedText(payLink(publicSiteOrigin("")));
    const lineUserId = found.line_user_id && lineUserIdOk(found.line_user_id) ? found.line_user_id : "";
    if (environment !== "live") {
      await deliverTenantLine({
        orgId: found.org_id,
        contactId: found.contact_id,
        lineUserId,
        kind: "payment_recorded",
        targetId: found.payment_id,
        text,
        environment: "sandbox",
      });
      await writeAudit(found.org_id, found.user_id, "notice_not_sent", {
        channel: "line",
        leaseId,
        note: SANDBOX_NOT_SENT,
      });
      return true;
    }
    const result = await deliverTenantLine({
      orgId: found.org_id,
      contactId: found.contact_id,
      lineUserId,
      kind: "payment_recorded",
      targetId: found.payment_id,
      text,
      environment: "live",
    });
    if (!result.ok && result.fallback) {
      await sendPaymentEmail({
        email: (found.email ?? "").trim(),
        name: (found.name ?? "").trim(),
        orgName: found.org_name,
        contactEmail: found.contact_email,
      });
    }
    return true;
  } catch (error) {
    if (missingRelation(error)) return false;
    console.error("payment line", error instanceof Error ? error.message : "failed");
    return true;
  }
}

async function ensurePlatformChannel(client: Client) {
  const found = await client.query<{ id: string }>(
    `SELECT id::text AS id
       FROM line_channels
      WHERE mode = 'platform_default' AND is_active
      ORDER BY created_at
      LIMIT 1`,
  );
  if (found.rows[0]) return found.rows[0].id;
  await client.query("SAVEPOINT line_channel");
  try {
    const inserted = await client.query<{ id: string }>(
      `INSERT INTO line_channels (
         mode, display_name, line_provider_id, messaging_channel_id,
         messaging_channel_secret_ref, messaging_access_token_ref, oa_basic_id
       ) VALUES (
         'platform_default', '租多啦通知', 'env', 'platform-env',
         'env:LINE_CHANNEL_SECRET', 'env:LINE_CHANNEL_ACCESS_TOKEN', $1
       ) RETURNING id::text AS id`,
      [lineBasicId()],
    );
    await client.query("RELEASE SAVEPOINT line_channel");
    return inserted.rows[0].id;
  } catch (error) {
    await client.query("ROLLBACK TO SAVEPOINT line_channel");
    const again = await client.query<{ id: string }>(
      `SELECT id::text AS id
         FROM line_channels
        WHERE mode = 'platform_default' AND is_active
        ORDER BY created_at
        LIMIT 1`,
    );
    if (again.rows[0]) return again.rows[0].id;
    throw error;
  }
}

async function consumeLinkCode(code: string, lineUserId: string) {
  return withClient(async (client) => {
    await client.query("BEGIN");
    try {
      const found = await client.query<{ id: string; org_id: string; contact_id: string }>(
        `SELECT id::text, org_id::text, contact_id::text
           FROM line_link_codes
          WHERE code = $1 AND used_at IS NULL AND expires_at > now()
          FOR UPDATE`,
        [code],
      );
      const row = found.rows[0];
      if (!row) {
        await client.query("COMMIT");
        return "rejected" as const;
      }
      const channelId = await ensurePlatformChannel(client);
      await client.query(
        `UPDATE line_account_links
            SET status = 'unlinked', unlinked_at = now(), updated_at = now()
          WHERE contact_id = $1 AND line_channel_id = $2 AND status IN ('pending', 'linked')`,
        [row.contact_id, channelId],
      );
      await client.query(
        `UPDATE contacts
            SET line_user_id = NULL, updated_at = now()
          WHERE org_id = $1 AND line_user_id = $2 AND id <> $3`,
        [row.org_id, lineUserId, row.contact_id],
      );
      await client.query(
        `INSERT INTO line_account_links (
           org_id, contact_id, line_channel_id, line_user_id, status, is_friend,
           consent_text_key, consented_at, linked_at
         ) VALUES ($1, $2, $3, $4, 'linked', true, 'line.link_code', now(), now())`,
        [row.org_id, row.contact_id, channelId, lineUserId],
      );
      await client.query(`UPDATE contacts SET line_user_id = $2, updated_at = now() WHERE id = $1`, [row.contact_id, lineUserId]);
      await client.query(`UPDATE line_link_codes SET used_at = now() WHERE id = $1`, [row.id]);
      await client.query("COMMIT");
      return "linked" as const;
    } catch (error) {
      await client.query("ROLLBACK");
      if (pgCode(error) === "23505") return "taken" as const;
      throw error;
    }
  });
}

async function setFriend(lineUserId: string, friend: boolean) {
  if (!lineUserIdOk(lineUserId)) return;
  await query(
    `UPDATE line_account_links
        SET is_friend = $2, updated_at = now()
      WHERE line_user_id = $1 AND status = 'linked'`,
    [lineUserId, friend],
  );
}

type WebhookEvent = {
  type?: string;
  replyToken?: string;
  source?: { userId?: string };
  message?: { type?: string; text?: string };
};

export async function handleLineWebhook(rawBody: string, signature: string | null) {
  const verdict = verifyLineWebhook(rawBody, signature);
  if (verdict !== "ok") return { status: 401, body: "unauthorized" };
  let payload: { events?: unknown };
  try {
    payload = JSON.parse(rawBody) as { events?: unknown };
  } catch {
    return { status: 400, body: "bad json" };
  }
  const events = Array.isArray(payload.events) ? payload.events.slice(0, 20) : [];
  for (const value of events) {
    if (!value || typeof value !== "object") continue;
    const event = value as WebhookEvent;
    if (event.type === "follow" || event.type === "unfollow") {
      await setFriend(event.source?.userId ?? "", event.type === "follow");
      continue;
    }
    if (event.type !== "message" || event.message?.type !== "text") continue;
    const code = linkCodeFromText(event.message.text ?? "");
    const userId = event.source?.userId ?? "";
    if (!code || !lineUserIdOk(userId)) continue;
    const outcome = await consumeLinkCode(code, userId);
    const text = outcome === "linked" ? LINE_REPLIES.linked : outcome === "taken" ? LINE_REPLIES.taken : LINE_REPLIES.rejected;
    if (event.replyToken) await replyLineText(event.replyToken, text);
  }
  return { status: 200, body: "ok" };
}
