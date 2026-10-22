import { randomBytes } from "node:crypto";
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
  lineLive,
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

const LINE_EVENTS = ["rent_due", "rent_overdue", "lease_expiry", "repair", "statement"] as const;
const CODE_LIMIT = 5;

export type StaffLineStatus = "unlinked" | "linked" | "blocked";

export type StaffLinePanel = {
  showLine: boolean;
  lineLive: boolean;
  status: StaffLineStatus;
  linkedOn: string | null;
  code: string | null;
  qrSvg: string | null;
  deepLink: string | null;
  prefs: Record<string, boolean>;
};

const EMPTY_PANEL: StaffLinePanel = {
  showLine: false,
  lineLive: false,
  status: "unlinked",
  linkedOn: null,
  code: null,
  qrSvg: null,
  deepLink: null,
  prefs: {},
};

function missingRelation(error: unknown) {
  const code = typeof error === "object" && error && "code" in error ? String((error as { code?: string }).code) : "";
  return code === "42P01" || code === "42703";
}

function pgCode(error: unknown) {
  return typeof error === "object" && error && "code" in error ? String((error as { code?: string }).code) : "";
}

function newLinkCode() {
  const n = randomBytes(4).readUInt32BE(0) % 1_000_000;
  return String(n).padStart(6, "0");
}

function defaultPref(event: string) {
  return event !== "repair";
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

async function orgFlags(orgId: string) {
  const row = await query<{ environment: string; plan_tier: string; feature_flags: unknown }>(
    `SELECT environment::text AS environment, plan_tier::text AS plan_tier, feature_flags
       FROM organizations
      WHERE id = $1`,
    [orgId],
  );
  const found = row.rows[0];
  if (!found) return null;
  const environment = found.environment === "sandbox" ? "sandbox" : "live";
  return {
    environment: environment as "live" | "sandbox",
    planTier: found.plan_tier,
    featureFlags: found.feature_flags,
    showLine: showLine({ environment, planTier: found.plan_tier, featureFlags: found.feature_flags }),
    lineLive: lineLive(found.feature_flags),
  };
}

export async function loadStaffLinePanel(session: Session): Promise<StaffLinePanel> {
  try {
    if (session.kind !== "staff") return EMPTY_PANEL;
    const org = await orgFlags(session.orgId);
    if (!org?.showLine) return EMPTY_PANEL;
    const link = await query<{ status: StaffLineStatus; linked_on: string | null }>(
      `SELECT status, to_char(linked_at AT TIME ZONE 'Asia/Taipei', 'YYYY-MM-DD') AS linked_on
         FROM line_user_links
        WHERE org_id = $1 AND user_id = $2
        ORDER BY CASE status WHEN 'linked' THEN 0 WHEN 'blocked' THEN 1 ELSE 2 END, updated_at DESC
        LIMIT 1`,
      [session.orgId, session.userId],
    );
    const status = link.rows[0]?.status ?? "unlinked";
    const codeRow = await query<{ code: string }>(
      `SELECT code
         FROM line_link_codes
        WHERE org_id = $1 AND user_id = $2 AND used_at IS NULL AND expires_at > now()
        ORDER BY created_at DESC
        LIMIT 1`,
      [session.orgId, session.userId],
    );
    const prefRows = await query<{ event_type: string; enabled: boolean }>(
      `SELECT event_type, enabled
         FROM line_notify_prefs
        WHERE org_id = $1 AND user_id = $2 AND channel = 'line'`,
      [session.orgId, session.userId],
    );
    const prefs: Record<string, boolean> = {};
    for (const event of LINE_EVENTS) prefs[event] = defaultPref(event);
    for (const row of prefRows.rows) prefs[row.event_type] = row.enabled === true;
    const code = codeRow.rows[0]?.code ?? null;
    const payload = code ? lineLinkPayload(code, lineBasicId()) : null;
    return {
      showLine: true,
      lineLive: org.lineLive,
      status,
      linkedOn: status === "linked" ? link.rows[0]?.linked_on ?? null : null,
      code,
      qrSvg: code && payload ? await qrSvg(payload) : null,
      deepLink: payload && payload.startsWith("https://") ? payload : null,
      prefs,
    };
  } catch (error) {
    if (missingRelation(error)) return { ...EMPTY_PANEL, showLine: true };
    throw error;
  }
}

export async function staffLinkStatus(session: Session) {
  const panel = await loadStaffLinePanel(session);
  return { status: panel.status, linkedOn: panel.linkedOn };
}

export async function issueStaffLineCode(session: Session): Promise<"ok" | "limit" | "off"> {
  if (session.kind !== "staff") return "off";
  const org = await orgFlags(session.orgId);
  if (!org?.showLine) return "off";
  const recent = await query<{ n: string }>(
    `SELECT count(*)::text AS n
       FROM line_link_codes
      WHERE org_id = $1 AND user_id = $2 AND created_at > now() - interval '60 minutes'`,
    [session.orgId, session.userId],
  );
  if (Number(recent.rows[0]?.n ?? 0) >= CODE_LIMIT) return "limit";
  await query(
    `UPDATE line_link_codes
        SET used_at = now()
      WHERE org_id = $1 AND user_id = $2 AND used_at IS NULL`,
    [session.orgId, session.userId],
  );
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const code = newLinkCode();
    try {
      await query(
        `INSERT INTO line_link_codes (org_id, user_id, code, expires_at)
         VALUES ($1, $2, $3, now() + interval '10 minutes')`,
        [session.orgId, session.userId, code],
      );
      return "ok";
    } catch (error) {
      if (pgCode(error) !== "23505") throw error;
    }
  }
  return "off";
}

export async function saveStaffLinePrefs(session: Session, enabledEvents: string[]) {
  if (session.kind !== "staff") return false;
  const org = await orgFlags(session.orgId);
  if (!org?.showLine) return false;
  const chosen = new Set(enabledEvents);
  for (const event of LINE_EVENTS) {
    await query(
      `INSERT INTO line_notify_prefs (org_id, user_id, event_type, channel, enabled)
       VALUES ($1, $2, $3, 'line', $4)
       ON CONFLICT (org_id, user_id, event_type, channel)
       DO UPDATE SET enabled = EXCLUDED.enabled, updated_at = now()`,
      [session.orgId, session.userId, event, chosen.has(event)],
    );
  }
  return true;
}

export async function unlinkStaffLine(session: Session) {
  if (session.kind !== "staff") return false;
  await query(
    `UPDATE line_user_links
        SET status = 'unlinked', updated_at = now()
      WHERE org_id = $1 AND user_id = $2 AND status = 'linked'`,
    [session.orgId, session.userId],
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
     ON CONFLICT (org_id, kind, target_id, contact_id) WHERE contact_id IS NOT NULL
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

type UserLogWrite = {
  orgId: string;
  userId: string;
  kind: LineKind;
  targetId: string;
  threshold: number;
  lineUserId: string | null;
  body: string;
  status: "sent" | "failed" | "skipped";
  providerMessageId: string | null;
  error: string | null;
};

async function writeUserLog(input: UserLogWrite) {
  const error = input.error ? input.error.slice(0, 200) : null;
  await query(
    `INSERT INTO line_delivery_log (
       org_id, user_id, kind, target_id, threshold, line_user_id, body, status, attempt,
       provider_message_id, error, next_retry_at, sent_at
     ) VALUES (
       $1, $2, $3, $4, $5, $6, $7, $8,
       CASE WHEN $8 = 'failed' THEN 1 ELSE 0 END,
       $9, $10,
       CASE WHEN $8 = 'failed' THEN now() + interval '15 minutes' ELSE NULL END,
       CASE WHEN $8 = 'sent' THEN now() ELSE NULL END
     )
     ON CONFLICT (org_id, kind, target_id, user_id, threshold) WHERE user_id IS NOT NULL
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
      input.userId,
      input.kind,
      input.targetId,
      input.threshold,
      input.lineUserId,
      input.body,
      input.status,
      input.providerMessageId,
      error,
    ],
  );
}

export type StaffLineDelivery = {
  orgId: string;
  userId: string;
  lineUserId: string;
  kind: "rent_due" | "rent_overdue" | "lease_expiry" | "repair" | "statement";
  targetId: string;
  threshold: number;
  text: string;
};

export async function deliverStaffLine(input: StaffLineDelivery): Promise<LineSendResult> {
  try {
    const existing = await query<{
      status: string;
      attempt: number;
      provider_message_id: string | null;
      next_retry_at: Date | null;
    }>(
      `SELECT status, attempt, provider_message_id, next_retry_at
         FROM line_delivery_log
        WHERE org_id = $1 AND kind = $2 AND target_id = $3 AND user_id = $4 AND threshold = $5`,
      [input.orgId, input.kind, input.targetId, input.userId, input.threshold],
    );
    const prior = existing.rows[0] ?? null;
    if (prior?.status === "sent") return { ok: true, messageId: prior.provider_message_id || "line-push" };
    if (prior?.status === "failed" && Number(prior.attempt) >= 3) return { ok: false, fallback: false, reason: "gave up" };
    if (prior?.status === "failed" && prior.next_retry_at && new Date(prior.next_retry_at).getTime() > Date.now()) {
      return { ok: false, fallback: false, reason: "waiting" };
    }
    const org = await orgFlags(input.orgId);
    const link = await query<{ line_user_id: string | null; status: string }>(
      `SELECT line_user_id, status
         FROM line_user_links
        WHERE org_id = $1 AND user_id = $2 AND status = 'linked'
        LIMIT 1`,
      [input.orgId, input.userId],
    );
    const pref = await query<{ enabled: boolean }>(
      `SELECT enabled
         FROM line_notify_prefs
        WHERE org_id = $1 AND user_id = $2 AND event_type = $3 AND channel = 'line'`,
      [input.orgId, input.userId, input.kind],
    );
    const enabled = pref.rows[0] ? pref.rows[0].enabled === true : input.kind !== "repair";
    const lineUserId = link.rows[0]?.line_user_id && lineUserIdOk(link.rows[0].line_user_id) ? link.rows[0].line_user_id : "";
    const ready = Boolean(org?.showLine && org.lineLive && org.environment === "live" && lineUserId && enabled);
    if (!ready || !linePushTextOk(input.text)) {
      await writeUserLog({
        orgId: input.orgId,
        userId: input.userId,
        kind: input.kind,
        targetId: input.targetId,
        threshold: input.threshold,
        lineUserId: lineUserId || null,
        body: input.text,
        status: "skipped",
        providerMessageId: null,
        error: !linePushTextOk(input.text) ? "line copy rejected" : "not_live",
      });
      return { ok: false, fallback: false, reason: "not_live" };
    }
    const creds = lineCredentials();
    if (!creds.ok) {
      await writeUserLog({
        orgId: input.orgId,
        userId: input.userId,
        kind: input.kind,
        targetId: input.targetId,
        threshold: input.threshold,
        lineUserId,
        body: input.text,
        status: "skipped",
        providerMessageId: null,
        error: creds.reason,
      });
      return { ok: false, fallback: false, reason: creds.reason };
    }
    const sent = await pushLineText(lineUserId, input.text);
    await writeUserLog({
      orgId: input.orgId,
      userId: input.userId,
      kind: input.kind,
      targetId: input.targetId,
      threshold: input.threshold,
      lineUserId,
      body: input.text,
      status: sent.ok ? "sent" : "failed",
      providerMessageId: sent.ok ? sent.messageId : null,
      error: sent.ok ? null : sent.reason,
    });
    if (!sent.ok) return { ok: false, fallback: false, reason: sent.reason };
    return { ok: true, messageId: sent.messageId };
  } catch (error) {
    if (missingRelation(error)) return { ok: false, fallback: false, reason: "line log missing" };
    console.error("line delivery", error instanceof Error ? error.message : "failed");
    return { ok: false, fallback: false, reason: "line delivery failed" };
  }
}

export async function retryFailedLinePushes() {
  if (!lineCredentials().ok) return 0;
  try {
    const rows = await query<{
      org_id: string;
      contact_id: string | null;
      user_id: string | null;
      kind: LineKind;
      target_id: string;
      threshold: number;
      line_user_id: string | null;
      body: string;
    }>(
      `SELECT org_id::text, contact_id::text, user_id::text, kind, target_id::text,
              threshold, line_user_id, body
         FROM line_delivery_log
        WHERE status = 'failed'
          AND attempt < 3
          AND (next_retry_at IS NULL OR next_retry_at <= now())
        ORDER BY created_at
        LIMIT 25`,
    );
    let sent = 0;
    for (const row of rows.rows) {
      if (row.user_id) {
        if (row.kind !== "rent_due" && row.kind !== "rent_overdue" && row.kind !== "lease_expiry" && row.kind !== "repair" && row.kind !== "statement") {
          continue;
        }
        const result = await deliverStaffLine({
          orgId: row.org_id,
          userId: row.user_id,
          lineUserId: row.line_user_id ?? "",
          kind: row.kind,
          targetId: row.target_id,
          threshold: Number(row.threshold) || 0,
          text: row.body,
        });
        if (result.ok) sent += 1;
        continue;
      }
      if (!row.contact_id || (row.kind !== "rent_reminder" && row.kind !== "payment_recorded")) continue;
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
    if (!lineLive(found.feature_flags)) return false;
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

async function consumeLinkCode(code: string, lineUserId: string) {
  return withClient(async (client) => {
    await client.query("BEGIN");
    try {
      const found = await client.query<{ id: string; org_id: string; user_id: string }>(
        `SELECT id::text, org_id::text, user_id::text
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
      await client.query(
        `UPDATE line_user_links
            SET status = 'unlinked', updated_at = now()
          WHERE org_id = $1 AND user_id = $2 AND status IN ('linked', 'blocked')`,
        [row.org_id, row.user_id],
      );
      await client.query(
        `INSERT INTO line_user_links (org_id, user_id, line_user_id, status, linked_at)
         VALUES ($1, $2, $3, 'linked', now())`,
        [row.org_id, row.user_id, lineUserId],
      );
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
  if (friend) return;
  try {
    await query(
      `UPDATE line_user_links
          SET status = 'blocked', blocked_at = now(), updated_at = now()
        WHERE line_user_id = $1 AND status = 'linked'`,
      [lineUserId],
    );
  } catch (error) {
    if (!missingRelation(error)) throw error;
  }
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
