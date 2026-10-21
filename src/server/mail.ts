/** Workers-compatible mail. Cloudflare Email Sending is the default. Brevo and Resend are config-selected backups. */

export type MailProvider = "cloudflare" | "brevo" | "resend";

/** Cloudflare Email Sending sender on send.condola.app. */
export const CLOUDFLARE_FROM = { email: "noreply@send.condola.app", name: "租多啦 Condola" };
/** String form for providers that take a single From header. */
export const MAIL_FROM = "\"租多啦 Condola\" <noreply@send.condola.app>";
/** Brevo sender. Supabase already authenticates this address on smtp-relay.brevo.com. */
export const BREVO_FROM_NAME = "租多啦 Condola";
export const BREVO_FROM_EMAIL = "no-reply@condola.app";
export const SERVICE_EMAIL = "service@condola.app";

export type MailMessage = {
  to: string;
  subject: string;
  html: string;
  text: string;
  replyTo?: string;
};

export type MailResult =
  | { ok: true; messageId: string; provider: MailProvider }
  | { ok: false; skipped: true; reason: string };

export type EmailAddress = string | { email: string; name?: string };

export type EmailSender = {
  send(message: {
    to: string;
    from: EmailAddress;
    subject: string;
    html?: string;
    text?: string;
    replyTo?: string;
  }): Promise<{ messageId: string }>;
};

/** `undefined` uses the Worker binding. Tests pass a fake or null. */
let bindingOverride: EmailSender | null | undefined;

export function useEmailBinding(binding: EmailSender | null | undefined) {
  bindingOverride = binding;
}

export function mailProviderName(env: NodeJS.ProcessEnv = process.env): MailProvider {
  const name = env.MAIL_PROVIDER?.trim().toLowerCase();
  if (name === "brevo" || name === "resend") return name;
  return "cloudflare";
}

export function replyToAddress(contactEmail: string | null | undefined) {
  const email = (contactEmail ?? "").trim();
  return email || SERVICE_EMAIL;
}

async function resolveEmailBinding(): Promise<EmailSender | null> {
  if (bindingOverride !== undefined) return bindingOverride;
  try {
    const mod = (await import("@opennextjs/cloudflare")) as {
      getCloudflareContext: (options?: { async?: boolean }) => Promise<{ env: { EMAIL?: EmailSender } }>;
    };
    const ctx = await mod.getCloudflareContext({ async: true });
    const email = ctx.env.EMAIL;
    if (email && typeof email.send === "function") return email;
  } catch {
    // Previews and `next dev` have no send_email binding.
  }
  return null;
}

export async function mailReady(): Promise<{ ok: true; provider: MailProvider } | { ok: false; reason: string }> {
  const provider = mailProviderName();
  if (provider === "brevo") {
    if (!process.env.BREVO_API_KEY) return { ok: false, reason: "BREVO_API_KEY missing" };
    return { ok: true, provider };
  }
  if (provider === "resend") {
    if (!process.env.RESEND_API_KEY) return { ok: false, reason: "RESEND_API_KEY missing" };
    return { ok: true, provider };
  }
  const binding = await resolveEmailBinding();
  if (!binding) return { ok: false, reason: "EMAIL binding missing" };
  return { ok: true, provider: "cloudflare" };
}

async function sendCloudflare(message: MailMessage): Promise<MailResult> {
  const binding = await resolveEmailBinding();
  if (!binding) {
    console.warn("mail skipped: EMAIL binding missing");
    return { ok: false, skipped: true, reason: "EMAIL binding missing" };
  }
  try {
    const result = await binding.send({
      to: message.to,
      from: CLOUDFLARE_FROM,
      subject: message.subject,
      html: message.html,
      text: message.text,
      replyTo: message.replyTo,
    });
    const messageId = result?.messageId || "";
    if (!messageId) {
      console.warn("mail skipped: EMAIL binding returned no messageId");
      return { ok: false, skipped: true, reason: "no messageId" };
    }
    console.info(`mail sent ${messageId}`);
    return { ok: true, messageId, provider: "cloudflare" };
  } catch (error) {
    console.error("mail send failed", error instanceof Error ? error.message : "failed");
    return { ok: false, skipped: true, reason: "send failed" };
  }
}

async function sendBrevo(message: MailMessage, fetchImpl: typeof fetch): Promise<MailResult> {
  const apiKey = process.env.BREVO_API_KEY || "";
  if (!apiKey) {
    console.warn("mail skipped: BREVO_API_KEY missing");
    return { ok: false, skipped: true, reason: "BREVO_API_KEY missing" };
  }
  try {
    // HTTPS transactional API. It delivers through the same Brevo relay
    // (smtp-relay.brevo.com) Supabase already uses. Workers have no raw SMTP socket.
    const response = await fetchImpl("https://api.brevo.com/v3/smtp/email", {
      method: "POST",
      headers: { "api-key": apiKey, accept: "application/json", "content-type": "application/json" },
      body: JSON.stringify({
        sender: { name: BREVO_FROM_NAME, email: BREVO_FROM_EMAIL },
        to: [{ email: message.to }],
        replyTo: message.replyTo ? { email: message.replyTo } : undefined,
        subject: message.subject,
        htmlContent: message.html,
        textContent: message.text,
      }),
    });
    const body = (await response.json().catch(() => ({}))) as { messageId?: string };
    if (!response.ok || !body.messageId) {
      console.warn("mail skipped: Brevo rejected the message");
      return { ok: false, skipped: true, reason: "brevo rejected" };
    }
    console.info(`mail sent ${body.messageId}`);
    return { ok: true, messageId: body.messageId, provider: "brevo" };
  } catch (error) {
    console.error("mail send failed", error instanceof Error ? error.message : "failed");
    return { ok: false, skipped: true, reason: "send failed" };
  }
}

async function sendResend(message: MailMessage, fetchImpl: typeof fetch): Promise<MailResult> {
  const apiKey = process.env.RESEND_API_KEY || "";
  if (!apiKey) {
    console.warn("mail skipped: RESEND_API_KEY missing");
    return { ok: false, skipped: true, reason: "RESEND_API_KEY missing" };
  }
  try {
    const response = await fetchImpl("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        from: MAIL_FROM,
        to: [message.to],
        subject: message.subject,
        html: message.html,
        text: message.text,
        reply_to: message.replyTo,
      }),
    });
    const body = (await response.json().catch(() => ({}))) as { id?: string };
    if (!response.ok || !body.id) {
      console.warn("mail skipped: Resend rejected the message");
      return { ok: false, skipped: true, reason: "resend rejected" };
    }
    console.info(`mail sent ${body.id}`);
    return { ok: true, messageId: body.id, provider: "resend" };
  } catch (error) {
    console.error("mail send failed", error instanceof Error ? error.message : "failed");
    return { ok: false, skipped: true, reason: "send failed" };
  }
}

export async function sendMail(message: MailMessage, fetchImpl: typeof fetch = fetch): Promise<MailResult> {
  const provider = mailProviderName();
  if (provider === "brevo") return sendBrevo(message, fetchImpl);
  if (provider === "resend") return sendResend(message, fetchImpl);
  return sendCloudflare(message);
}
