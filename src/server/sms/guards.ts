import { createHmac } from "node:crypto";
import { isIP } from "node:net";
import type { E164 } from "./transport";

export function normalizeE164(raw: unknown): E164 | null {
  if (typeof raw !== "string") return null;
  const value = raw.trim();
  return /^\+[1-9]\d{7,14}$/.test(value) ? (value as E164) : null;
}

// Ron (2026-11-19 12:03): US mobile first; +886 stays at zero until the TW allowlist is approved.
export const SLICE_COUNTRY_PREFIXES = ["+1"] as const;

export function inSliceCountry(e164: E164): boolean {
  return e164.startsWith(SLICE_COUNTRY_PREFIXES[0]) && /^\+1[2-9]\d{9}$/.test(e164);
}

export function parseDestAllowlist(value: string | undefined):
  | { ok: true; set: ReadonlySet<string> }
  | { ok: false; reason: "dest_allowlist_missing" | "dest_allowlist_invalid" } {
  const entries = (value ?? "").split(",").map((entry) => entry.trim());
  if (entries.every((entry) => entry === "")) return { ok: false, reason: "dest_allowlist_missing" };

  const set = new Set<string>();
  for (const entry of entries) {
    const number = normalizeE164(entry);
    if (number === null) return { ok: false, reason: "dest_allowlist_invalid" };
    set.add(number);
  }
  return { ok: true, set };
}

export function maskE164(e164: E164): string {
  const prefix = e164.startsWith("+1") ? "+1" : "+";
  return prefix + "•".repeat(e164.length - prefix.length - 2) + e164.slice(-2);
}

function hmac128(secret: string, value: string): string {
  return createHmac("sha256", secret).update(value).digest("hex").slice(0, 32);
}

export function numberKey(e164: E164, secret: string): string {
  return "smsn_" + hmac128(secret, e164);
}

export function deviceKey(deviceId: string | null, secret: string): string {
  return deviceId === null ? "smsd_none" : "smsd_" + hmac128(secret, `device:${deviceId}`);
}

export function ipLiteralOrNull(value: string | null): string | null {
  // Only bare literals: no ports, brackets, CIDR suffixes, or IPv6 zone IDs.
  return value !== null && /^[0-9A-Fa-f:.]{1,45}$/.test(value) && isIP(value) !== 0 ? value : null;
}

// B044-AC-P10: Shared across all purposes.
export const PER_NUMBER_HOUR = 3;
export const PER_NUMBER_DAY = 5;
export const PER_IP_HOUR = 10;
export const PER_DEVICE_HOUR = 5;
export const RESEND_SECONDS = 45;

export type SmsRateRefusal =
  | "rate_context_missing"
  | "rate_resend_wait"
  | "rate_number_hour"
  | "rate_number_day"
  | "rate_ip_hour"
  | "rate_device_hour";

export function rateLimitBlock(c: {
  numberHour: number;
  numberDay: number;
  ipHour: number;
  deviceHour: number;
  secondsSinceLastToNumber: number | null;
}): SmsRateRefusal | null {
  if (c.secondsSinceLastToNumber !== null && c.secondsSinceLastToNumber < RESEND_SECONDS) {
    return "rate_resend_wait";
  }
  if (c.numberHour >= PER_NUMBER_HOUR) return "rate_number_hour";
  if (c.numberDay >= PER_NUMBER_DAY) return "rate_number_day";
  if (c.ipHour >= PER_IP_HOUR) return "rate_ip_hour";
  if (c.deviceHour >= PER_DEVICE_HOUR) return "rate_device_hour";
  return null;
}

export const SMS_DAILY_SEND_HARD_CAP = 5;

export function dailyCap(env: Record<string, string | undefined>): number {
  const value = env.SMS_DAILY_SEND_CAP;
  if (!value || /[^0-9]/.test(value)) return SMS_DAILY_SEND_HARD_CAP;
  return Math.min(Number(value), SMS_DAILY_SEND_HARD_CAP);
}

export function costCapBlock(attemptsToday: number, cap: number): null | "daily_cost_cap" {
  return attemptsToday >= cap ? "daily_cost_cap" : null;
}
