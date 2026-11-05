import { FlowError } from "./errors";
import type { LocalizationContext } from "./localization";

export type ExportExplanation = {
  currencyKey: "explain.currency.context";
  scaleKey: "explain.scale.minorUnit";
  localeKey: "explain.locale.context";
  timezoneKey: "explain.timezone.context";
  jurisdictionKey: "explain.jurisdiction.configured" | null;
};

function invalid(): never {
  throw new FlowError("errors.generic");
}

function requireRegionalContext(ctx: LocalizationContext): void {
  if (typeof ctx.locale !== "string" || !ctx.locale ||
      typeof ctx.timezone !== "string" || !ctx.timezone.trim()) invalid();
  try {
    const locales = Intl.getCanonicalLocales(ctx.locale);
    if (Intl.NumberFormat.supportedLocalesOf(locales, { localeMatcher: "lookup" }).length !== 1 ||
        Intl.DateTimeFormat.supportedLocalesOf(locales, { localeMatcher: "lookup" }).length !== 1) {
      invalid();
    }
    new Intl.DateTimeFormat(ctx.locale, { timeZone: ctx.timezone });
  } catch {
    invalid();
  }
}

function requireScale(value: number): void {
  // Use the precision range supported across the application's Intl runtimes.
  if (!Number.isInteger(value) || value < 0 || value > 20) invalid();
}

export function formatMoneyMinor(
  amountMinor: number,
  ctx: LocalizationContext,
  amountCurrency?: string,
): string {
  requireRegionalContext(ctx);
  requireScale(ctx.minorUnit);
  requireScale(ctx.displayDecimals);
  if (!Number.isSafeInteger(amountMinor) ||
      typeof ctx.currency !== "string" || !/^[A-Z]{3}$/.test(ctx.currency) ||
      (amountCurrency !== undefined && amountCurrency !== ctx.currency)) invalid();
  const abs = BigInt(Math.abs(amountMinor));
  const scale = 10n ** BigInt(ctx.minorUnit);
  let whole = abs / scale;
  let frac = abs % scale;
  const displayScale = 10n ** BigInt(ctx.displayDecimals);
  if (ctx.displayDecimals < ctx.minorUnit) {
    const divisor = 10n ** BigInt(ctx.minorUnit - ctx.displayDecimals);
    // Round half away from zero on the magnitude, including ties and carries.
    frac = (frac + divisor / 2n) / divisor;
    whole += frac / displayScale;
    frac %= displayScale;
  } else {
    frac *= 10n ** BigInt(ctx.displayDecimals - ctx.minorUnit);
  }
  const negative = amountMinor < 0 || Object.is(amountMinor, -0);
  const signedWhole = negative ? (whole === 0n ? -0 : -whole) : whole;
  const fraction = ctx.displayDecimals === 0 ? "" : new Intl.NumberFormat(ctx.locale, {
    useGrouping: false,
    minimumIntegerDigits: ctx.displayDecimals,
    maximumFractionDigits: 0,
  }).formatToParts(frac).filter(part => part.type === "integer").map(part => part.value).join("");
  // Intl formats the exact BigInt whole, sign, grouping and currency placement.
  // Replace only the fraction with exact, zero-padded digits in the same locale.
  return new Intl.NumberFormat(ctx.locale, {
    style: "currency",
    currency: ctx.currency,
    minimumFractionDigits: ctx.displayDecimals,
    maximumFractionDigits: ctx.displayDecimals,
  }).formatToParts(signedWhole)
    .map(part => part.type === "fraction" ? fraction : part.value)
    .join("");
}

export function formatRegionalNumber(value: number, ctx: LocalizationContext): string {
  requireRegionalContext(ctx);
  requireScale(ctx.displayDecimals);
  if (!Number.isFinite(value)) invalid();
  return new Intl.NumberFormat(ctx.locale, {
    minimumFractionDigits: ctx.displayDecimals,
    maximumFractionDigits: ctx.displayDecimals,
  }).format(value);
}

/** Accept calendar dates or explicit-offset instants; never parse host-local time. */
function parseIso(iso: string, requireTime: boolean): Date {
  if (typeof iso !== "string") invalid();
  const match = /^(\d{4}-\d{2}-\d{2})(?:T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?(Z|[+-]\d{2}:\d{2}))?$/.exec(iso);
  if (!match || (requireTime && !match[2])) invalid();
  const calendar = new Date(match[1] + "T00:00:00Z");
  if (!Number.isFinite(calendar.getTime()) ||
      calendar.toISOString().slice(0, 10) !== match[1]) invalid();
  if (match[2]) {
    if (Number(match[2]) > 23 || Number(match[3]) > 59 || Number(match[4]) > 59) invalid();
    const offset = match[6];
    if (offset !== "Z" &&
        (Number(offset.slice(1, 3)) > 23 || Number(offset.slice(4, 6)) > 59)) invalid();
  }
  const date = match[2] ? new Date(iso) : calendar;
  if (!Number.isFinite(date.getTime())) invalid();
  return date;
}

/** Date-only input is midnight UTC; all inputs display in the context timezone. */
export function formatRegionalDate(iso: string, ctx: LocalizationContext): string {
  requireRegionalContext(ctx);
  return new Intl.DateTimeFormat(ctx.locale, {
    timeZone: ctx.timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(parseIso(iso, false));
}

/** Date-time input must include seconds and Z or an explicit numeric offset. */
export function formatRegionalDateTime(iso: string, ctx: LocalizationContext): string {
  requireRegionalContext(ctx);
  return new Intl.DateTimeFormat(ctx.locale, {
    timeZone: ctx.timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).format(parseIso(iso, true));
}

/** Descriptive keys only. A configured jurisdiction grants no enforcement or permission. */
export function buildExportExplanation(
  ctx: LocalizationContext,
  opts?: { includeJurisdiction?: boolean },
): ExportExplanation {
  return {
    currencyKey: "explain.currency.context",
    scaleKey: "explain.scale.minorUnit",
    localeKey: "explain.locale.context",
    timezoneKey: "explain.timezone.context",
    jurisdictionKey: opts?.includeJurisdiction === false ||
      typeof ctx.jurisdictionCode !== "string" || !ctx.jurisdictionCode.trim()
      ? null
      : "explain.jurisdiction.configured",
  };
}
