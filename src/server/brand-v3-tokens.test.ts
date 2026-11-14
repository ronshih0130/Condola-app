import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import postcss from "postcss";
import tokens from "../brand/v3/tokens.json";
import v2 from "../brand/v2/tokens.json";

const css = readFileSync("public/brand/v3/theme.css", "utf8");
const tree = postcss.parse(css);
const scope = 'html[data-brand="v2"][data-brand-v3]';

test("PLT-47-AC1 / PLT-50-AC2: every v3 delta token is present and exact; unchanged tokens stay inherited", () => {
  const expected = Object.fromEntries([tokens.color, tokens.radius].flatMap(group =>
    Object.entries(group).map(([name, token]) => {
      assert.equal(token.css, `var(--${name})`);
      return [`--${name}`, token.value];
    })));
  assert.equal(tokens.$schema, v2.$schema);
  const found: Record<string, string> = {};
  tree.walkRules(scope, rule => { rule.walkDecls(d => { found[d.prop] = d.value; }); });
  for (const [name, value] of Object.entries(expected)) assert.equal(found[name], value, name);
  tree.walkDecls(d => {
    if (d.prop in expected) assert.equal(d.value, expected[d.prop], d.prop);
    if (/^--(?:c-primary|c-brand|c-success|c-danger|c-info|font|fs-|sp-|shadow)/.test(d.prop)) {
      assert.fail(`unchanged token redeclared: ${d.prop}`);
    }
  });
  assert.equal(tokens.color["c-bg"].value, "#F6F3EE");
  assert.equal(tokens.color["c-text-3"].value, "#5F6978");
  assert.equal(tokens.color["c-warning"].value, "#8A560C");
});

test("PLT-46-AC1 / PLT-47-AC4: all style selectors, including media rules, are v3 scoped and flat fills only", () => {
  let count = 0;
  tree.walkRules(rule => {
    if (rule.parent?.type === "atrule" && rule.parent.name === "keyframes") {
      assert.equal(rule.parent.params, "v3-tick");
      return;
    }
    for (const selector of rule.selectors) assert.ok(selector.startsWith(scope), selector);
    count++;
  });
  assert.ok(count > 30);
  assert.doesNotMatch(css, /gradient\(/i);
  // A flat v3 file must also clear the gradients inherited from these v2 surfaces.
  const knownGradientRoots = [".idv-watermark", ".rich", ".shot"];
  const covered = new Set<string>();
  const inherited = postcss.parse(readFileSync("src/app/globals.css", "utf8"));
  inherited.walkRules(rule => {
    if (!rule.nodes.some(node => node.type === "decl" && /gradient\(/i.test(node.value))) return;
    for (const selector of rule.selectors) {
      const root = knownGradientRoots.find(root => selector === root || selector.startsWith(`${root} `));
      if (!root) continue;
      covered.add(root);
      let clearsGradient = false;
      tree.walkRules(override => {
        if (!override.selectors.includes(`${scope} ${selector}`)) return;
        override.walkDecls(d => {
          if (d.prop === "background" || d.prop === "background-image") {
            clearsGradient = !/gradient\(|\b(?:inherit|revert(?:-layer)?)\b/i.test(d.value);
          }
        });
      });
      assert.ok(clearsGradient, `inherited gradient needs a v3 override: ${selector}`);
    }
  });
  assert.deepEqual([...covered].sort(), [...knownGradientRoots].sort());
  assert.doesNotMatch(css, /@import|url\(["']?https?:/i);
});

test("PLT-47-AC1…AC3 / PLT-50-AC4: buttons, row actions, focus, sand header and status masks have scoped rules", () => {
  const rules = new Map<string, string>();
  tree.walkRules(rule => { rules.set(rule.selector, rule.toString()); });
  assert.match(rules.get(`${scope} .btn`)!, /min-height: 44px/);
  assert.match(rules.get(`${scope} .btn`)!, /border-radius: var\(--r-btn\)/);
  assert.match(rules.get(`${scope} :is(table, li, [role="row"], .list-row) .btn.pri`)!, /background: var\(--c-surface\)/);
  assert.match(rules.get(`${scope} .btn.pri:focus-visible`)!, /outline: 2px solid #fff; outline-offset: -4px/);
  assert.match(rules.get(`${scope} .ph`)!, /background: var\(--c-tint-soft\)/);
  for (const status of ["ok", "warn", "bad"]) {
    assert.match(rules.get(`${scope} .pill.${status}::before`)!, /mask: url/);
  }
});
