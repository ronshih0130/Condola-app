// Run with: npx tsx --test src/server/brand-v2-tokens.test.ts
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import tokens from "../brand/v2/tokens.json";
import legacyTokens from "../brand/tokens.json";
import { brandV2CssVars, brandV2Tokens } from "./brand-v2";

const css = readFileSync(
  new URL("../../public/brand/v2/theme.css", import.meta.url),
  "utf8",
).replace(/\/\*[\s\S]*?\*\//g, "");

type Token = { value: string; css: string };

const entries: [string, Token][] = Object.values(tokens).flatMap((group) => {
  if (!group || typeof group !== "object" || Array.isArray(group)) return [];
  return Object.entries(group).filter(
    (entry): entry is [string, Token] => {
      const value: unknown = entry[1];
      return typeof value === "object"
        && value !== null
        && "value" in value
        && typeof value.value === "string"
        && "css" in value
        && typeof value.css === "string";
    },
  );
});

const expected = Object.fromEntries(
  entries.map(([name, token]) => [`--${name}`, token.value]),
);

const rules = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map(
  ([, selector, body]) => ({
    selector: selector.trim(),
    declarations: body.split(";").flatMap((declaration) => {
      const colon = declaration.indexOf(":");
      if (colon < 0) return [];
      return [{
        property: declaration.slice(0, colon).trim(),
        value: declaration.slice(colon + 1).trim(),
      }];
    }),
  }),
);

const rootRule = rules.find(({ selector }) => selector === 'html[data-brand="v2"]');
assert.ok(rootRule, "v2 token scope exists");
const rootVariables = Object.fromEntries(
  rootRule.declarations
    .filter(({ property }) => property.startsWith("--"))
    .map(({ property, value }) => [property, value]),
);

function resolveValue(
  value: string,
  variables: Record<string, string>,
  seen = new Set<string>(),
): string {
  return value.replace(/var\(\s*(--[\w-]+)\s*\)/g, (_, name: string) => {
    assert.ok(!seen.has(name), `cyclic custom property: ${name}`);
    assert.ok(name in variables, `undefined custom property: ${name}`);
    return resolveValue(variables[name], variables, new Set([...seen, name]));
  });
}

function variablesFor(rule: (typeof rules)[number]): Record<string, string> {
  return {
    ...rootVariables,
    ...Object.fromEntries(
      rule.declarations
        .filter(({ property }) => property.startsWith("--"))
        .map(({ property, value }) => [property, value]),
    ),
  };
}

test("R&D JSON contains exactly 73 tokens and is exported intact", () => {
  assert.equal(entries.length, 73);
  assert.deepEqual(brandV2Tokens, tokens);
});

test("every declared token custom property matches the R&D value", () => {
  let checked = 0;
  for (const rule of rules) {
    for (const { property, value } of rule.declarations) {
      if (Object.hasOwn(expected, property)) {
        assert.equal(value, expected[property], `${rule.selector}: ${property}`);
        checked++;
      }
    }
  }
  assert.ok(checked >= Object.keys(tokens.color).length);
  for (const name of Object.keys(tokens.color)) {
    assert.equal(rootVariables[`--${name}`], expected[`--${name}`]);
  }
});

test("CSS variable helper maps every token name to its exact value", () => {
  assert.deepEqual(brandV2CssVars(), expected);
  const result = brandV2CssVars();
  result["--c-primary"] = "changed";
  assert.equal(brandV2CssVars()["--c-primary"], "#14325C");
});

test("solid button fills are navy only; other button backgrounds are neutral surfaces", () => {
  const allowed = new Set([
    "transparent", "none", "inherit",
    tokens.color["c-bg"].value.toLowerCase(),
    tokens.color["c-surface"].value.toLowerCase(),
    tokens.color["c-surface-2"].value.toLowerCase(),
    tokens.color["c-primary"].value.toLowerCase(),
    tokens.color["c-primary-hover"].value.toLowerCase(),
    tokens.color["c-primary-pressed"].value.toLowerCase(),
  ]);
  let checked = 0;
  for (const rule of rules) {
    const selectors = rule.selector.split(",");
    if (!selectors.some((selector) =>
      /\bbutton\b|\[role\s*=\s*["']?button["']?\]|\.btn\b|\.nav-toggle\b|\.env-toggle\b/i
        .test(selector))) continue;

    for (const { property, value } of rule.declarations) {
      if (property !== "background" && property !== "background-color") continue;
      const resolved = resolveValue(value, variablesFor(rule)).toLowerCase();
      assert.notEqual(resolved, "#2f6bff", rule.selector);
      assert.ok(allowed.has(resolved), `${rule.selector}: ${property}: ${resolved}`);
      checked++;
    }
  }
  assert.ok(checked > 0, "button backgrounds were inspected");
});

test("accent usage is restricted to logo, selected and focus selectors", () => {
  let checked = 0;
  for (const rule of rules) {
    const variables = variablesFor(rule);
    for (const { property, value } of rule.declarations) {
      // Definitions are inert; validate their resolved values at use sites.
      if (property.startsWith("--")) continue;
      const resolved = resolveValue(value, variables);
      const usesAccent = /#2f6bff\b/i.test(resolved)
        || /var\(\s*--c-accent\b/i.test(value);
      if (!usesAccent) continue;

      for (const selector of rule.selector.split(",")) {
        assert.match(
          selector,
          /logo|selected|aria-selected|aria-current|focus/i,
          `${selector}: ${property}: ${value}`,
        );
      }
      assert.ok(
        !/^background(?:-|$)/i.test(property)
          || !rule.selector.split(",").some((selector) =>
            /\bbutton\b|\.btn\b|\[role\s*=\s*["']?button/i.test(selector)),
        "accent must never fill a button",
      );
      checked++;
    }
  }
  assert.ok(checked > 0, "focus accent usage was inspected");
});

test("Latin stacks use Inter and Jakarta; Chinese uses installed system fonts", () => {
  assert.match(rootVariables["--font-latin"], /"Inter"/);
  assert.match(rootVariables["--font-sans"], /"Inter"/);
  assert.match(rootVariables["--font-display"], /"Plus Jakarta Sans"/);

  for (const name of ["--font-cjk", "--font-sans", "--font-display"]) {
    assert.match(rootVariables[name], /"PingFang TC"/, name);
    assert.match(rootVariables[name], /"Microsoft JhengHei"/, name);
  }
  assert.match(rootVariables["--font-sans"], /system-ui/);
  assert.match(rootVariables["--font-display"], /system-ui/);

  const faces = rules.filter(({ selector }) => selector === "@font-face");
  assert.equal(faces.length, 2);
  const families = faces.map(({ declarations }) =>
    declarations.find(({ property }) => property === "font-family")?.value);
  assert.deepEqual(families.sort(), ['"Inter"', '"Plus Jakarta Sans"']);

  for (const face of faces) {
    for (const { property, value } of face.declarations) {
      if (property === "src") {
        assert.doesNotMatch(value, /noto/i);
      }
    }
  }
});

test("production OFF palette retains its pinned primary", () => {
  assert.equal(legacyTokens.color.primary, "#B4532A");
});
