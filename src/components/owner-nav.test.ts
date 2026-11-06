import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

test("OwnerNav: B-023 entries only when extensions is ON; OFF markup is unchanged", async () => {
  // owner-nav.tsx / locale.tsx rely on the Next JSX runtime; tsx compiles them with classic React.createElement.
  (globalThis as { React?: typeof React }).React = React;
  const { LocaleProvider } = await import("./locale");
  const { OwnerNav } = await import("./owner-nav");
  const render = (props: { extensions?: boolean }, locale: "zh-TW" | "en" = "zh-TW") =>
    renderToStaticMarkup(React.createElement(LocaleProvider as React.FC<{ locale: "zh-TW" | "en"; children?: React.ReactNode }>, { locale },
      React.createElement(OwnerNav as React.FC<{ extensions?: boolean; children?: React.ReactNode }>, props, React.createElement("p", null, "child"))));
  const off = render({}), explicitOff = render({ extensions: false });
  assert.equal(explicitOff, off);
  for (const html of [off, explicitOff]) {
    assert.doesNotMatch(html, /\/o\/files|\/o\/repairs|\/o\/lifecycle|\/o\/messages|\/o\/account|owner-nav-files|owner-nav-repairs|owner-nav-lifecycle|owner-nav-messages|owner-nav-account/);
  }
  const on = render({ extensions: true });
  assert.match(on, /data-testid="owner-nav-files" href="\/o\/files">文件</);
  assert.match(on, /data-testid="owner-nav-repairs" href="\/o\/repairs">報修進度</);
  assert.match(on, /data-testid="owner-nav-lifecycle" href="\/o\/lifecycle">租約回覆</);
  assert.match(on, /data-testid="owner-nav-messages" href="\/o\/messages">訊息</);
  assert.match(on, /data-testid="owner-nav-account" href="\/o\/account">帳號</);
  assert.match(render({ extensions: true }, "en"), />Documents<[\s\S]*>Repairs<[\s\S]*>Lease replies<[\s\S]*>Messages<[\s\S]*>Account</);
  // Existing entries are identical with and without the extension entries.
  const base = (html: string) => html.replace(/<a[^>]*owner-nav-(files|repairs|lifecycle|messages|account)[^>]*>[^<]*<\/a>/g, "");
  assert.equal(base(on), off);
});
