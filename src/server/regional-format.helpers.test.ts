import assert from "node:assert/strict";
import test from "node:test";
import { FlowError } from "./errors";
import type { LocalizationContext } from "./localization";
import {
  formatMoneyMinor, formatRegionalNumber, formatRegionalDate, formatRegionalDateTime,
} from "./regional-format-helpers";

const ctx: LocalizationContext = {
  currency: "TWD", minorUnit: 2, displayDecimals: 0,
  locale: "en-US", timezone: "UTC", jurisdictionCode: null,
};

function rejects(run: () => unknown): void {
  assert.throws(run, error => error instanceof FlowError && error.key === "errors.generic");
}

test("money restores storage scale before applying display precision (100x regression)", () => {
  assert.equal(formatMoneyMinor(280000, ctx, "TWD"), "NT$2,800");
  assert.equal(formatMoneyMinor(280000, { ...ctx, displayDecimals: 2 }), "NT$2,800.00");
  const wrongMajor = 280000 / 10 ** ctx.displayDecimals;
  const correctMajor = 280000 / 10 ** ctx.minorUnit;
  assert.equal(wrongMajor / correctMajor, 100);
  assert.equal(new Intl.NumberFormat(ctx.locale, {
    style: "currency", currency: ctx.currency, maximumFractionDigits: 0,
  }).format(wrongMajor), "NT$280,000");
  assert.notEqual(formatMoneyMinor(280000, ctx), "NT$280,000");
});

test("money supports zero and three storage exponents, negatives, zero and locale", () => {
  assert.equal(formatMoneyMinor(280000, { ...ctx, currency: "USD", displayDecimals: 2 }), "$2,800.00");
  assert.equal(formatMoneyMinor(1234, { ...ctx, currency: "JPY", minorUnit: 0 }), "¥1,234");
  const three = { ...ctx, currency: "USD", minorUnit: 3, displayDecimals: 3 };
  assert.equal(formatMoneyMinor(1234, three), "$1.234");
  assert.equal(formatMoneyMinor(-1234, three), "-$1.234");
  assert.equal(formatMoneyMinor(0, three), "$0.000");
  assert.equal(formatMoneyMinor(123456, {
    ...ctx, currency: "EUR", locale: "de-DE", displayDecimals: 2,
  }), "1.234,56\u00a0€");
});

test("currency mismatch rejects instead of converting or relabelling", () => {
  for (const currency of ["USD", "twd", "", " TWD", null, 42]) {
    rejects(() => formatMoneyMinor(280000, ctx, currency as string));
  }
  assert.equal(formatMoneyMinor(280000, ctx), formatMoneyMinor(280000, ctx, "TWD"));
});

test("money rejects unsafe amounts, malformed currency and invalid scales", () => {
  for (const amount of [NaN, Infinity, -Infinity, 1.5, Number.MAX_SAFE_INTEGER + 1, "100", null]) {
    rejects(() => formatMoneyMinor(amount as number, ctx));
  }
  for (const value of [-1, 1.5, 21, NaN, Infinity, "2", null]) {
    rejects(() => formatMoneyMinor(1, { ...ctx, minorUnit: value as number }));
    rejects(() => formatMoneyMinor(1, { ...ctx, displayDecimals: value as number }));
    rejects(() => formatRegionalNumber(1, { ...ctx, displayDecimals: value as number }));
  }
  for (const currency of ["", "usd", "US", "USDD", null]) {
    rejects(() => formatMoneyMinor(1, { ...ctx, currency: currency as string }));
  }
});

test("numbers use locale and display precision without changing storage scale", () => {
  assert.equal(formatRegionalNumber(1234.5, {
    ...ctx, locale: "de-DE", displayDecimals: 2, minorUnit: 3,
  }), "1.234,50");
  for (const value of [NaN, Infinity, -Infinity, "1", null]) {
    rejects(() => formatRegionalNumber(value as number, ctx));
  }
});

test("all formatters reject malformed and unsupported locales or timezones", () => {
  const formatters = [
    (c: LocalizationContext) => formatMoneyMinor(1, c),
    (c: LocalizationContext) => formatRegionalNumber(1, c),
    (c: LocalizationContext) => formatRegionalDate("2024-02-29", c),
    (c: LocalizationContext) => formatRegionalDateTime("2024-02-29T12:00:00Z", c),
  ];
  for (const format of formatters) {
    for (const locale of ["", " ", "en_US", "zz-ZZ", null, 42]) {
      rejects(() => format({ ...ctx, locale: locale as string }));
    }
    for (const timezone of ["", " ", "Mars/Olympus", " UTC ", null, 42]) {
      rejects(() => format({ ...ctx, timezone: timezone as string }));
    }
  }
});

test("dates and instants use the supplied timezone, including DST boundaries", () => {
  const west = { ...ctx, timezone: "America/Los_Angeles" };
  assert.equal(formatRegionalDate("2024-01-01T00:30:00Z", west), "12/31/2023");
  assert.equal(formatRegionalDate("2024-01-01T00:30:00Z", ctx), "01/01/2024");
  assert.equal(formatRegionalDate("2024-02-29", { ...ctx, locale: "de-DE" }), "29.02.2024");
  assert.equal(formatRegionalDateTime("2024-03-10T09:30:00Z", west), "03/10/2024, 01:30:00 AM");
  assert.equal(formatRegionalDateTime("2024-03-10T10:30:00Z", west), "03/10/2024, 03:30:00 AM");
  assert.equal(formatRegionalDateTime("2024-03-10T03:30:00-07:00", west),
    formatRegionalDateTime("2024-03-10T10:30:00Z", west));
  assert.equal(formatRegionalDate("2024-01-01", west), "12/31/2023");
});

test("date parsing rejects rollover, ambiguous local time and malformed ISO", () => {
  for (const iso of [
    "", "2023-02-29", "2024-02-30", "2024-04-31", "2024-13-01", "2024-00-01",
    "2024-01-00", "01/02/2024", "2024-1-1", "2024-01-01T12:00:00",
    "2024-01-01T24:00:00Z", "2024-01-01T12:60:00Z", "2024-01-01T12:00:60Z",
    "2024-02-30T00:00:00Z", "2024-01-01T12:00:00+24:00",
    "2024-01-01T12:00:00+00:60", "2024-01-01T12:00:00Z trailing", null, 42,
  ]) {
    rejects(() => formatRegionalDate(iso as string, ctx));
    rejects(() => formatRegionalDateTime(iso as string, ctx));
  }
  rejects(() => formatRegionalDateTime("2024-02-29", ctx));
  assert.equal(formatRegionalDate("2024-02-29T23:59:59.123Z", ctx), "02/29/2024");
});
