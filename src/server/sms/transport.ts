import type { SmsPurpose } from "./purposes";

export type E164 = string & { readonly __e164: unique symbol };
export type SmsTransportMode = "capture" | "live";
export type SmsVerificationCheck = { status: "captured" | "approved" | "rejected" };

export interface SmsTransport {
  readonly mode: SmsTransportMode;
  readonly provider: "capture" | "twilio_verify";
  startVerification(input: {
    to: E164;
    purpose: SmsPurpose;
    locale?: "zh-TW" | "en";
  }): Promise<{ status: "captured" | "pending"; providerRef: string | null }>;
  /** Capture mode does not check the code. Only an "approved" result authorizes verification. */
  checkVerification(input: {
    to: E164;
    purpose: SmsPurpose;
    code: string;
  }): Promise<SmsVerificationCheck>;
}

export function isApproved(result: SmsVerificationCheck): result is { status: "approved" } {
  return result.status === "approved";
}

type CaptureSink = (capture: { to: E164; purpose: SmsPurpose; at: number }) => void;

export function createCaptureTransport(sink?: CaptureSink): SmsTransport {
  return {
    mode: "capture",
    provider: "capture",
    async startVerification({ to, purpose }) {
      sink?.({ to, purpose, at: Date.now() });
      return { status: "captured", providerRef: null };
    },
    async checkVerification() {
      return { status: "captured" };
    },
  };
}

export function createTwilioVerifyTransport(cfg: {
  accountSid: string;
  authToken: string;
  serviceSid: string;
  fetchImpl?: typeof fetch;
}): SmsTransport {
  const baseUrl = `https://verify.twilio.com/v2/Services/${encodeURIComponent(cfg.serviceSid)}`;

  async function post(endpoint: "Verifications" | "VerificationCheck", body: URLSearchParams): Promise<unknown> {
    let response: Response;
    try {
      const fetchImpl = cfg.fetchImpl ?? globalThis.fetch;
      response = await fetchImpl(`${baseUrl}/${endpoint}`, {
        method: "POST",
        headers: {
          Authorization: `Basic ${btoa(`${cfg.accountSid}:${cfg.authToken}`)}`,
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body,
        redirect: "manual",
        signal: AbortSignal.timeout(10_000),
      });
    } catch {
      throw new Error("twilio_verify_request_failed");
    }

    const { status, type } = response;
    if (type === "opaqueredirect" || status === 0 || (status >= 300 && status < 400)) {
      throw new Error(`twilio_verify_http_${status}`);
    }
    // Verify may return 404 for an expired or already-used verification.
    if (endpoint === "VerificationCheck" && status === 404) return null;
    if (!response.ok) throw new Error(`twilio_verify_http_${status}`);

    try {
      return await response.json();
    } catch {
      throw new Error("twilio_verify_invalid_response");
    }
  }

  return {
    mode: "live",
    provider: "twilio_verify",
    async startVerification({ to, locale }) {
      const body = new URLSearchParams({ To: to, Channel: "sms" });
      // Do not substitute Hong Kong Chinese for Taiwanese Chinese.
      if (locale === "en") body.set("Locale", "en");
      const result = await post("Verifications", body);
      const providerRef = result !== null && typeof result === "object" &&
        "sid" in result && typeof result.sid === "string" ? result.sid : null;
      return { status: "pending", providerRef };
    },
    async checkVerification({ to, code }) {
      const result = await post("VerificationCheck", new URLSearchParams({ To: to, Code: code }));
      const approved = result !== null && typeof result === "object" &&
        "status" in result && result.status === "approved";
      return { status: approved ? "approved" : "rejected" };
    },
  };
}

export function selectTransport(
  env: Record<string, string | undefined>,
  deps?: { fetchImpl?: typeof fetch; captureSink?: CaptureSink },
): { transport: SmsTransport } | { error: "live_config_missing" } {
  if (env.SMS_TRANSPORT_MODE !== "live") {
    return { transport: createCaptureTransport(deps?.captureSink) };
  }
  const accountSid = env.TWILIO_ACCOUNT_SID?.trim();
  const authToken = env.TWILIO_AUTH_TOKEN?.trim();
  const serviceSid = env.TWILIO_VERIFY_SERVICE_SID?.trim();
  if (!accountSid || !authToken || !serviceSid) return { error: "live_config_missing" };

  return {
    transport: createTwilioVerifyTransport({
      accountSid,
      authToken,
      serviceSid,
      ...(deps?.fetchImpl ? { fetchImpl: deps.fetchImpl } : {}),
    }),
  };
}
