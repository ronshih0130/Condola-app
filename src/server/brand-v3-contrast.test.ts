import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import postcss from "postcss";
import v2 from "../brand/v2/tokens.json";
import v3 from "../brand/v3/tokens.json";

const colors: Record<string, { value: string }> = { ...v2.color, ...v3.color };
const color = (name: string) => colors[name]?.value ?? name;
function luminance(hex: string) {
  const rgb = color(hex).slice(1).match(/../g)!.map(x => parseInt(x, 16) / 255)
    .map(x => x <= .04045 ? x / 12.92 : ((x + .055) / 1.055) ** 2.4);
  return rgb[0] * .2126 + rgb[1] * .7152 + rgb[2] * .0722;
}
function contrast(a: string, b: string) {
  const [light, dark] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (light + .05) / (dark + .05);
}

test("PLT-50-AC1: approved text and outline pairs meet WCAG thresholds without rounding up", () => {
  const pairs = [
    ...["c-text", "c-text-2", "c-text-3"].map(fg => [fg, "c-bg"]),
    ["c-text-3", "c-tint-soft"], ["c-text-3", "c-surface"],
    ...["c-bg", "c-tint-soft", "c-surface"].map(bg => ["c-brand-ink", bg]),
    ["c-info", "c-surface"], ["c-info", "c-bg"],
    ["c-warning", "c-warning-soft"],
    ...["m", "t", "o", "v"].map(r => [`c-party-${r}-fg`, `c-party-${r}-fill`]),
  ];
  for (const [fg, bg] of pairs) assert.ok(contrast(fg, bg) >= 4.5, `${fg} on ${bg}: ${contrast(fg, bg)}`);
  for (const [fg, bg] of [
    ["c-brand", "c-bg"], ["c-border-strong", "c-surface"],
    ["c-primary", "c-tint-soft"],
    ...["m", "t", "o", "v"].map(r => [`c-party-${r}-line`, "c-surface"]),
  ]) assert.ok(contrast(fg, bg) >= 3, `${fg} on ${bg}`);
  // The design's 4.50 is rounded: the exact cobalt/white ratio is slightly below 4.5.
  assert.equal(contrast("c-brand", "c-surface").toFixed(2), "4.50");
  assert.ok(contrast("c-brand", "c-surface") < 4.5);
});

test("PLT-50-AC5: input, textarea and select placeholders use opaque text-3 on white at 4.5:1 or better", () => {
  const css = postcss.parse(readFileSync("public/brand/v3/theme.css", "utf8"));
  const scope = 'html[data-brand="v2"][data-brand-v3]';
  for (const selector of ['.inp::placeholder', 'textarea::placeholder', 'select.inp:has(> option[value=""]:checked)', 'select.inp > option[value=""]']) {
    const values: Record<string, string> = {};
    css.walkRules(rule => {
      if (rule.selectors.includes(`${scope} ${selector}`)) rule.walkDecls(d => { values[d.prop] = d.value; });
    });
    assert.equal(values.color, "var(--c-text-3)", selector);
    assert.equal(values.opacity, "1", selector);
  }
  assert.ok(contrast("c-text-3", "#FFFFFF") >= 4.5);
});

test("PLT-50-AC2 / AC3: forbidden combinations still fail, documenting why the delta is required", () => {
  for (const [fg, bg] of [
    [v2.color["c-text-3"].value, "c-bg"],
    [v2.color["c-warning"].value, "c-warning-soft"],
    ["c-brand", "c-bg"], ["c-brand", "c-tint-soft"], ["c-info", "c-tint-soft"],
  ]) assert.ok(contrast(fg, bg) < 4.5, `${fg} on ${bg}`);
  for (const role of ["t", "o"]) assert.ok(contrast(`c-party-${role}-line`, "c-tint-soft") < 3);
  assert.ok(contrast("c-surface", "c-bg") < 3);
});

test("PLT-50-AC3 / PLT-48-AC3 / PLT-47-AC4: sand blocks avoid cobalt/info text, darken avatar outlines, and retain card shadows", () => {
  const css = postcss.parse(readFileSync("public/brand/v3/theme.css", "utf8"));
  const rings = new Set<string>();
  css.walkRules(rule => {
    if (/\.v3-lead|\.ph\b/.test(rule.selector)) {
      rule.walkDecls("color", d => { assert.doesNotMatch(d.value, /var\(--c-(brand|info)\)/); });
      if (rule.selector.endsWith(" .party")) rule.walkDecls("border-color", d => {
        assert.equal(d.value, "var(--c-primary)"); rings.add(rule.selector);
      });
    }
    if (/\.card\b/.test(rule.selector)) rule.walkDecls("box-shadow", d => { assert.notEqual(d.value, "none"); });
  });
  assert.equal(rings.size, 2);
});


test("OV-SH-PHONE: title-only sand lead uses text at >= 4.5:1 and never info/cobalt", () => {
  const css = postcss.parse(readFileSync("public/brand/v3/shell.css", "utf8"));
  const values: Record<string, string> = {};
  css.walkRules(rule => {
    if (!rule.selector.includes(".shell-phone-lead")) return;
    rule.walkDecls("color", d => assert.doesNotMatch(d.value, /var\(--c-(brand|info)\)/));
    if (rule.selector === 'html[data-brand="v2"][data-brand-v3] .v3-shell .shell-phone-lead') {
      rule.walkDecls(d => { values[d.prop] = d.value; });
    }
  });
  assert.equal(values.background, "var(--c-tint-soft)");
  assert.equal(values.color, "var(--c-text)");
  assert.ok(contrast("c-text", "c-tint-soft") >= 4.5);
});
