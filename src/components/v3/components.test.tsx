import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import postcss from "postcss";
import { RoleAvatar } from "./role-avatar";
import { TurnTag } from "./turn-tag";
import { CompletionCheck } from "./completion-check";
import { Illustration } from "./illustrations";
import { brandV3Copy } from "../../i18n/lanes/brand-v3";
import { EmptyState } from "../empty-state";
import { TenantPaymentHistory } from "../tenant-payment-history";

// Existing server components use the application's JSX runtime.
Object.assign(globalThis, { React });

test("role avatars render all four glyphs and localized accessible role names", () => {
  for (const locale of ["zh-TW", "en"] as const) {
    for (const [role, glyph] of [["m", "管"], ["t", "租"], ["o", "屋"], ["v", "廠"]] as const) {
      const html = renderToStaticMarkup(<RoleAvatar role={role} locale={locale} />);
      assert.match(html, new RegExp(`>${glyph}</span>`));
      assert.ok(html.includes(`aria-label="${brandV3Copy(locale)[role]}"`));
      assert.match(html, /role="img"/);
      assert.ok(html.includes(`party-${role}`));
    }
  }
});

test("account avatars use surname initials and retain the full accessible name", () => {
  for (const [name, glyph] of [["陳小明", "陳"], ["Ada Lovelace", "L"]]) {
    const html = renderToStaticMarkup(<RoleAvatar role="m" locale="zh-TW" name={name} />);
    assert.match(html, /party-name/);
    assert.ok(html.includes(`>${glyph}</span>`));
    assert.ok(html.includes(`aria-label="管理方：${name}"`));
  }
  assert.ok(renderToStaticMarkup(<RoleAvatar role="t" locale="en" name="  " />).includes(">租</span>"));
});

test("decorative avatars preserve the glyph without repeating the adjacent accessible name", () => {
  for (const role of ["m", "t", "o", "v"] as const) {
    for (const name of [undefined, "陳小明", "Ada Lovelace"]) {
      const baseline = renderToStaticMarkup(<RoleAvatar role={role} locale="en" name={name} />);
      const decorative = renderToStaticMarkup(<RoleAvatar role={role} locale="en" name={name} decorative />);
      assert.match(decorative, /aria-hidden="true"/);
      assert.doesNotMatch(decorative, /\brole=|aria-label=/);
      assert.equal(decorative.replace(' aria-hidden="true"', ""), baseline.replace(' role="img"', "").replace(/ aria-label="[^"]*"/, ""));
    }
  }
});

test("turn tag marks the supplied step without inventing new copy", () => {
  assert.equal(renderToStaticMarkup(<TurnTag>Confirm</TurnTag>), '<span class="turn-tag" aria-current="step">Confirm</span>');
});

test("completion mark renders the entire logo with the tick last and reduced motion static", () => {
  const html = renderToStaticMarkup(<CompletionCheck />);
  assert.match(html, /class="v3-check" aria-hidden="true"/);
  assert.equal((html.match(/<path /g) ?? []).length, 2);
  assert.ok(html.indexOf('stroke="var(--c-primary)"') < html.indexOf('class="v3-check-tick"'));
  assert.match(html, /pathLength="1"/);
  const css = postcss.parse(readFileSync("public/brand/v3/theme.css", "utf8"));
  let staticRule = false;
  css.walkAtRules("media", media => {
    if (media.params !== "(prefers-reduced-motion: reduce)") return;
    media.walkRules('html[data-brand="v2"][data-brand-v3] .v3-check-tick', rule => {
      const values: Record<string, string> = {};
      rule.walkDecls(d => { values[d.prop] = d.value; });
      assert.equal(values.animation, "none");
      assert.equal(values["stroke-dashoffset"], "0");
      staticRule = true;
    });
  });
  assert.ok(staticRule);
});

test("approved illustrations retain decorative SVG geometry and theme variables", () => {
  for (const name of ["04", "05", "06", "08", "24", "26"] as const) {
    const html = renderToStaticMarkup(<Illustration name={name} />);
    assert.match(html, /viewBox="0 0 176 120"/);
    assert.match(html, /aria-hidden="true"/);
    assert.match(html, /var\(--c-primary\)/);
    assert.equal((html.match(/var\(--c-brand\)/g) ?? []).length, 1);
    assert.doesNotMatch(html, /#[0-9a-f]{3,8}|<title|aria-label/i);
  }
});

test("empty-state illustration slot leaves OFF markup identical", () => {
  for (const id of ["PAY", "TIX", "MSG", "MSG_joined"] as const) {
    const baseline = renderToStaticMarkup(<EmptyState id={id} locale="en" />);
    assert.equal(renderToStaticMarkup(<EmptyState id={id} locale="en" illustration={undefined} />), baseline);
    const on = renderToStaticMarkup(<EmptyState id={id} locale="en" illustration={<Illustration name="04" />} />);
    assert.match(on, /data-v3-illustration="04"/);
    assert.equal(on.replace(/<svg[\s\S]*?<\/svg>/, ""), baseline.replace(/<svg[\s\S]*?<\/svg>/, ""));
  }
});

test("tenant completion is confirmed-only and flag OFF preserves the payment view", () => {
  type Ready = Parameters<typeof TenantPaymentHistory>[0]["data"];
  const data: Ready = {
    state: "ready", lease: { id: "lease", status: "active", currency: "TWD", canReport: false, legacyPayeeVisible: false },
    bill: { state: "paid", overdue: false, pending: false, balanceMinor: 0, paidMinor: 100, currency: "TWD", lines: [] },
    monthlyDue: [], nextCursor: null,
    reports: [{ id: "payment", status: "confirmed", current: { amountMinor: 100, currency: "TWD", paidOn: "2026-11-01" },
      submittedAt: "2026-11-01", confirmedAt: "2026-11-02", rejectionReason: null, reversalReason: "unavailable", original: { state: "unavailable" } }],
  };
  for (const status of ["submitted", "confirmed", "rejected", "reversed"] as const) {
    data.reports[0].status = status;
    const baseline = renderToStaticMarkup(<TenantPaymentHistory data={data} locale="en" pathname="/t/pay" />);
    const off = renderToStaticMarkup(<TenantPaymentHistory data={data} locale="en" pathname="/t/pay" v3={false} />);
    const on = renderToStaticMarkup(<TenantPaymentHistory data={data} locale="en" pathname="/t/pay" v3 />);
    assert.equal(off, baseline);
    assert.doesNotMatch(off, /v3-check/);
    assert.equal(on.includes('class="v3-check"'), status === "confirmed");
  }
});
