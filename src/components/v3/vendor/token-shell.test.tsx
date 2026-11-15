import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ts from "typescript";
import { VendorTokenShell, type VendorTokenShellProps } from "./token-shell";
import { vendorTokenCopy } from "../../../i18n/lanes/brand-v3-vendor-token";
import { ownStatusCopy } from "../../../i18n/lanes/brand-v3-own-status";

const props: VendorTokenShellProps = {
  locale: "zh-TW", context: { name: "陳師傅", company: "測試公司", property: "測試公寓", status: "assigned" },
  title: "水龍頭", address: "測試地址", window: "Monday", status: "已指派", reported: false, canReport: true,
  children: <section data-testid="existing">Existing controls</section>,
};

test("V-TOKEN / OV-SH-PHONE: ven-off lead, scoped brand, exact job card, no avatar or login", () => {
  const html = renderToStaticMarkup(<VendorTokenShell {...props} />);
  for (const text of ["租多啦・廠商", "陳師傅 你好｜管理方：測試公司", "這一案", "測試公寓・水龍頭", "狀態", "地址", "約定到場", "已指派", "測試地址", "Monday", vendorTokenCopy("zh-TW").off, "回報進度"]) assert.ok(html.includes(text), text);
  assert.match(html, /href="#.*?"/);
  assert.match(html, /data-testid="existing"/);
  assert.doesNotMatch(html, /href="\/(?:login|v|api)|avatar|role="menu"|sidebar|登入後看全部未結案件/);
  assert.equal((html.match(/aria-haspopup="dialog"/g) ?? []).length, 4, "three tabs plus bell");
});

test("V-TOKEN: reported handoff uses clock, no completion tick or report primary", () => {
  const html = renderToStaticMarkup(<VendorTokenShell {...props} reported canReport={false} status="已回報，待公司核對" />);
  assert.match(html, /v3-wait/); assert.match(html, /已回報，待公司核對/);
  assert.doesNotMatch(html, /v3-completion|>回報進度</);
});

test("OV-SH-NONAME / locale: absent names never invent a signed-in identity", () => {
  for (const locale of ["en", "zh-TW"] as const) {
    const html = renderToStaticMarkup(<VendorTokenShell {...props} locale={locale} context={{ ...props.context, name: "" }} />);
    assert.ok(html.includes(vendorTokenCopy(locale).contextNoName.replace("{company}", props.context.company)));
    assert.ok(html.includes(ownStatusCopy(locale).vendorTab));
    assert.doesNotMatch(html, /你好｜|Hello |avatar/);
  }
});

test("V-TOKEN-TABS: each actual handler opens the same native modal, return closes, zero network", t => {
  let calls = 0; let opened = 0; let closed = 0;
  t.mock.method(globalThis, "fetch", async () => { calls++; throw new Error("No network allowed"); });
  const requireHere = createRequire(import.meta.url);
  const source = readFileSync(new URL("./token-shell.tsx", import.meta.url), "utf8");
  const output = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true } }).outputText;
  const exports: Record<string, unknown> = {};
  let ids = 0;
  new Function("require", "exports", output)((name: string) => name === "react" ? {
    ...React, useId: () => `test-${++ids}`, useRef: () => ({ current: { showModal() { opened++; }, close() { closed++; } } }),
  } : requireHere(name), exports);
  const Component = exports.VendorTokenShell as (p: VendorTokenShellProps) => React.ReactNode;
  type Element = React.ReactElement<Record<string, unknown>>;
  function all(node: React.ReactNode): Element[] {
    if (Array.isArray(node)) return node.flatMap(all);
    if (!React.isValidElement(node)) return [];
    const element = node as Element;
    return [element, ...all(element.props.children as React.ReactNode)];
  }
  const nodes = all(Component(props));
  const tabs = nodes.filter(node => node.type === "button" && node.props["aria-haspopup"] === "dialog");
  assert.equal(tabs.length, 4);
  for (const tab of tabs) (tab.props.onClick as () => void)();
  assert.equal(opened, 4);
  const modal = nodes.find(node => node.type === "dialog")!;
  assert.ok(modal.props["aria-labelledby"]); assert.ok(modal.props["aria-describedby"]);
  const html = renderToStaticMarkup(modal);
  assert.match(html, /登入後才能看全部未結案件/);
  assert.match(html, /單案連結只能處理這一張工單，不會因此看到歷史清單。/);
  assert.equal((html.match(/<button/g) ?? []).length, 1);
  const back = nodes.find(node => node.type === "button" && node.props.children === vendorTokenCopy("zh-TW").back)!;
  (back.props.onClick as () => void)();
  assert.equal(closed, 1); assert.equal(calls, 0);
  assert.doesNotMatch(source, /fetch\(|useRouter|useEffect|\/login|\/notifications|\/api\//);
});

test("V-TOKEN: token-only scoped CSS, 44px controls, centered phone at desktop, outline existing actions", () => {
  const css = readFileSync("public/brand/v3/vendor-token.css", "utf8");
  assert.doesNotMatch(css, /#[a-f0-9]{3,8}\b|linear-gradient|@media/i);
  assert.match(css, /min-height: 44px/); assert.match(css, /min-width: 44px/);
  assert.match(css, /max-width: 560px; margin-inline: auto/);
  assert.match(css, /safe-area-inset-bottom/);
  assert.match(css, /\.v-token-existing \.btn \{[^}]*background: var\(--c-surface\)/);
});
