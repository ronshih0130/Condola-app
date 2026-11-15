import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ts from "typescript";
import postcss from "postcss";
import * as money from "../../../../i18n/lanes/brand-v3-money";
import * as own from "../../../../i18n/lanes/brand-v3-own-status";
import * as brand from "../../../../i18n/lanes/brand-v3";
import { CompletionCheck } from "../../completion-check";
import type * as Components from "./proxy-confirmation";

const requireHere = createRequire(import.meta.url);
const source = readFileSync("src/components/v3/m/money/proxy-confirmation.tsx", "utf8");
function load(react: unknown = React, action: (data: FormData) => Promise<"confirmed" | "already_confirmed" | "proxy_unavailable"> = async () => "confirmed", refresh = () => {}) {
  const exports = {};
  const mocks: Record<string, unknown> = {
    react, "next/navigation": { useRouter: () => ({ refresh }) },
    "../../../../i18n/lanes/brand-v3-money": money, "../../../../i18n/lanes/brand-v3-own-status": own,
    "../../../../i18n/lanes/brand-v3": brand, "../../../../server/actions": { actionConfirmPayment: action },
    "../../completion-check": { CompletionCheck },
  };
  const code = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS,
    target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX } }).outputText;
  new Function("require", "exports", code)((name: string) => name in mocks ? mocks[name] : requireHere(name), exports);
  return exports as typeof Components;
}
const components = load();
const details = { paymentId: "synthetic-payment", ownerName: "Synthetic owner", target: "Synthetic tenant · A",
  amount: "NT$1,000", date: "2026-11-15", locale: "zh-TW" as const, returnTo: "/m/payments?month=2026-11&tab=yours" };
const noop = () => {};
const body = (overrides: Partial<React.ComponentProps<typeof components.ProxySheetBody>> = {}) => renderToStaticMarkup(
  <components.ProxySheetBody {...details} step="confirm" busy={false} failed={false} submit={noop} close={noop} {...overrides} />);

test("M-PROXY approved title/note, four details, one solid primary, no completion before success", () => {
  const html = renderToStaticMarkup(<components.ProxySheet {...details} onClose={noop} />);
  assert.ok(html.includes(own.ownStatusCopy("zh-TW").proxyTitle));
  assert.ok(html.includes(own.ownStatusCopy("zh-TW").proxyNote));
  for (const label of ["對象", "金額", "日期", "屋主", details.target, details.amount, details.date, details.ownerName]) assert.ok(html.includes(label));
  assert.equal((html.match(/class="btn pri"/g) ?? []).length, 1);
  assert.match(html, /代為確認/); assert.match(html, /取消/);
  assert.doesNotMatch(html, /v3-check|proxy-done/);
  assert.match(html, /<dialog[^>]+aria-labelledby=/);
});

test("M-PROXY success uses only approved own-status copy with escaped name and the existing tick", () => {
  for (const locale of ["zh-TW", "en"] as const) {
    const html = body({ step: "done", locale });
    assert.ok(html.includes(own.ownStatusCopy(locale).proxyDone.replace("{屋主}", details.ownerName)));
    assert.match(html, /role="status" data-testid="proxy-done"/);
    assert.match(html, /class="v3-check" aria-hidden="true"/);
    assert.doesNotMatch(html, /btn pri|<form/);
  }
  const html = body({ step: "done", ownerName: "<img src=x onerror=alert(1)>" });
  assert.doesNotMatch(html, /<img/); assert.match(html, /&lt;img/);
});

test("M-PROXY failure preserves all values and retries with one primary; pending disables both actions", () => {
  const html = body({ failed: true });
  for (const value of [details.target, details.amount, details.date, details.ownerName]) assert.ok(html.includes(value));
  assert.match(html, /role="alert"/); assert.match(html, /再試一次/);
  assert.equal((html.match(/class="btn pri"/g) ?? []).length, 1);
  assert.equal((body({ busy: true }).match(/disabled=""/g) ?? []).length, 2);
});

test("M-PROXY cancel writes nothing; double submission is blocked; failed action retries the identical id", async () => {
  // Run the actual hook component with a small deterministic state/ref host. No Next or DB runtime.
  let cursor = 0;
  const cells: unknown[] = [], calls: FormData[] = [], closed: boolean[] = [];
  let resolve: (() => void) | undefined, reject: (() => void) | undefined;
  const react = { ...React,
    useState(initial: unknown) { const index = cursor++; if (!(index in cells)) cells[index] = initial;
      return [cells[index], (value: unknown) => { cells[index] = value; }]; },
    useRef(initial: unknown) { const index = cursor++; if (!(index in cells)) cells[index] = { current: initial }; return cells[index]; },
    useId: () => "proxy-title", useEffect: noop,
  };
  const loaded = load(react, data => { calls.push(data); return new Promise<"confirmed">((yes, no) => { resolve = () => yes("confirmed"); reject = () => no(new Error("synthetic")); }); });
  function render() {
    cursor = 0;
    const element = loaded.ProxySheet({ ...details, onClose: value => closed.push(value) });
    return element.props.children[1].props as React.ComponentProps<typeof loaded.ProxySheetBody>;
  }
  render().close(); assert.deepEqual(closed, [false]); assert.equal(calls.length, 0);
  render().submit(); render().submit(); render().close();
  assert.equal(calls.length, 1); assert.equal(render().busy, true); assert.deepEqual(closed, [false]);
  assert.deepEqual(Object.fromEntries(calls[0]), { paymentId: details.paymentId, returnTo: details.returnTo,
    proxyOwnerConfirmed: "true", presentation: "owner-proxy" });
  reject!(); await new Promise(setImmediate);
  assert.equal(render().failed, true); assert.equal(render().step, "confirm");
  render().submit(); assert.equal(calls.length, 2);
  assert.deepEqual(Object.fromEntries(calls[1]), Object.fromEntries(calls[0]));
  resolve!(); await new Promise(setImmediate);
  assert.equal(render().step, "done"); assert.equal(render().busy, false);
  render().submit(); assert.equal(calls.length, 2);
  render().close(); assert.deepEqual(closed, [false, true]);
});

test("M-PROXY 44px targets, token colors, v3 scoping and shared reduced-motion tick", () => {
  const css = postcss.parse(readFileSync("public/brand/v3/money.css", "utf8"));
  let targets = false;
  css.walkRules(rule => {
    assert.ok(rule.selector.startsWith('html[data-brand="v2"][data-brand-v3]'));
    if (rule.selector.endsWith(".v3-proxy-sheet button")) {
      const values = Object.fromEntries(rule.nodes.filter(node => node.type === "decl").map(node => [node.prop, node.value]));
      assert.equal(values["min-height"], "44px"); assert.equal(values["min-width"], "44px"); targets = true;
    }
  });
  assert.equal(targets, true);
  css.walkDecls(decl => assert.doesNotMatch(decl.value, /#[0-9a-f]{3,8}\b|rgba?\(/i));
  const theme = postcss.parse(readFileSync("public/brand/v3/theme.css", "utf8"));
  let reduced = false;
  theme.walkAtRules("media", rule => {
    if (rule.params.includes("prefers-reduced-motion: reduce")) rule.walkRules(r => {
      if (r.selector.includes(".v3-check-tick")) r.walkDecls("animation", d => { assert.equal(d.value, "none"); reduced = true; });
    });
  });
  assert.equal(reduced, true);
});

test("terminal outcomes show neutral copy, no tick/retry, block submission and refresh on close", async () => {
  for (const outcome of ["already_confirmed", "proxy_unavailable"] as const) {
    let cursor = 0, calls = 0;
    const cells: unknown[] = [], closed: boolean[] = [];
    const react = { ...React,
      useState(initial: unknown) { const i = cursor++; if (!(i in cells)) cells[i] = initial; return [cells[i], (v: unknown) => { cells[i] = v; }]; },
      useRef(initial: unknown) { const i = cursor++; if (!(i in cells)) cells[i] = { current: initial }; return cells[i]; },
      useId: () => "title", useEffect: noop,
    };
    const loaded = load(react, async () => { calls++; return outcome; });
    const render = () => { cursor = 0; return loaded.ProxySheet({ ...details, onClose: value => closed.push(value) }).props.children[1].props; };
    render().submit(); await new Promise(setImmediate);
    assert.equal(render().step, outcome);
    render().submit(); assert.equal(calls, 1);
    for (const locale of ["zh-TW", "en"] as const) {
      const html = body({ ...render(), locale });
      assert.ok(html.includes(outcome === "already_confirmed" ? money.moneyPageCopy(locale).alreadyConfirmed : money.moneyPageCopy(locale).proxyError));
      assert.doesNotMatch(html, /v3-check|proxy-done|<form|type="submit"|btn pri/);
      assert.ok(html.includes(money.moneyPageCopy(locale).proxyClose));
    }
    render().close(); assert.deepEqual(closed, [true]);
  }
});

test("dialog cleanup focuses the persistent month heading after native dialog focus restoration", () => {
  const effects: (() => void | (() => void))[] = [];
  const events: string[] = [];
  const heading = { focus: () => events.push("heading") };
  const previousDocument = Object.getOwnPropertyDescriptor(globalThis, "document");
  const doc = { body: { style: { overflow: "auto" } }, getElementById: (id: string) => {
    assert.equal(id, "money-month-heading"); return heading;
  } };
  Object.defineProperty(globalThis, "document", { configurable: true, value: doc });
  try {
    const loaded = load({ ...React, useState: (v: unknown) => [v, noop], useId: () => "title",
      useRef: () => ({ current: { showModal: noop, close: () => events.push("dialog-close"), focus: noop } }),
      useEffect: (effect: () => void | (() => void)) => effects.push(effect),
    });
    loaded.ProxySheet({ ...details, onClose: noop });
    const cleanup = effects[0]();
    assert.equal(doc.body.style.overflow, "hidden");
    assert.equal(typeof cleanup, "function");
    cleanup!();
    assert.deepEqual(events, ["dialog-close", "heading"]);
    assert.equal(doc.body.style.overflow, "auto");
  } finally {
    if (previousDocument) Object.defineProperty(globalThis, "document", previousDocument);
    else Reflect.deleteProperty(globalThis, "document");
  }
});

test("closing a settled sheet disables its stale trigger and refreshes; cancel leaves it usable", () => {
  for (const settled of [false, true]) {
    let cursor = 0, refreshes = 0;
    const cells: unknown[] = [];
    const loaded = load({ ...React,
      useState(initial: unknown) { const i = cursor++; if (!(i in cells)) cells[i] = initial; return [cells[i], (v: unknown) => { cells[i] = v; }]; },
    }, async () => "confirmed", () => { refreshes++; });
    const render = () => { cursor = 0; return loaded.ProxyConfirmation(details); };
    render().props.children[0].props.onClick();
    render().props.children[1].props.onClose(settled);
    assert.equal(render().props.children[0].props.disabled, settled);
    assert.equal(render().props.children[1], false);
    assert.equal(refreshes, settled ? 1 : 0);
  }
});
