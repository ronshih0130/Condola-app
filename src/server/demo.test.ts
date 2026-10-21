import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { appFooterText, LINE_SUPPORT_CONTACT } from "../line-copy";
import { demoModeEnabled, enforceDemoSafety, lineLoginEnabled, showDemoLineCopy } from "./demo";
import { acceptSecondFactor } from "./totp";

const secret = "JBSWY3DPEHPK3PXP";
const at = Date.parse("2026-10-20T08:00:00Z");

function env() {
  return {
    DEMO_MODE: process.env.DEMO_MODE,
    NODE_ENV: process.env.NODE_ENV,
    CONDOLA_ENV: process.env.CONDOLA_ENV,
    NEXT_PHASE: process.env.NEXT_PHASE,
    LINE_LOGIN_ENABLED: process.env.LINE_LOGIN_ENABLED,
  };
}

function setEnv(key: string, value: string | undefined) {
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}

function restore(previous: ReturnType<typeof env>) {
  for (const [key, value] of Object.entries(previous)) setEnv(key, value);
}

test("the 123456 bypass and demo mode are rejected when DEMO_MODE is unset or the env is production", () => {
  const previous = env();
  try {
    delete process.env.DEMO_MODE;
    delete process.env.CONDOLA_ENV;
    delete process.env.NEXT_PHASE;
    setEnv("NODE_ENV", "development");
    assert.equal(demoModeEnabled(), false);
    assert.equal(acceptSecondFactor(secret, "123456", at), false);
    assert.doesNotThrow(() => enforceDemoSafety());

    process.env.DEMO_MODE = "true";
    setEnv("NODE_ENV", "production");
    assert.equal(demoModeEnabled(), false);
    assert.equal(acceptSecondFactor(secret, "123456", at), false);
    assert.throws(() => enforceDemoSafety(), /Refusing to start/);

    setEnv("NODE_ENV", "development");
    for (const flag of ["production", "staging", "staging-real"]) {
      process.env.CONDOLA_ENV = flag;
      assert.equal(demoModeEnabled(), false);
      assert.equal(acceptSecondFactor(secret, "123456", at), false);
      assert.throws(() => enforceDemoSafety(), /Refusing to start/);
    }

    process.env.NEXT_PHASE = "phase-production-build";
    assert.equal(demoModeEnabled(), false);
    assert.equal(acceptSecondFactor(secret, "123456", at), false);
    assert.doesNotThrow(() => enforceDemoSafety());
  } finally {
    restore(previous);
  }
});

test("LINE_LOGIN_ENABLED is ignored and refuses to start in production", () => {
  const previous = env();
  try {
    delete process.env.CONDOLA_ENV;
    delete process.env.NEXT_PHASE;
    delete process.env.DEMO_MODE;
    setEnv("NODE_ENV", "development");
    process.env.LINE_LOGIN_ENABLED = "true";
    assert.equal(lineLoginEnabled(), true);
    assert.doesNotThrow(() => enforceDemoSafety());

    setEnv("NODE_ENV", "production");
    assert.equal(lineLoginEnabled(), false);
    assert.throws(() => enforceDemoSafety(), /LINE_LOGIN_ENABLED/);

    setEnv("NODE_ENV", "development");
    for (const flag of ["production", "staging", "staging-real"]) {
      process.env.CONDOLA_ENV = flag;
      assert.equal(lineLoginEnabled(), false);
      assert.throws(() => enforceDemoSafety(), /Refusing to start/);
    }

    delete process.env.CONDOLA_ENV;
    process.env.LINE_LOGIN_ENABLED = "false";
    process.env.DEMO_MODE = "true";
    assert.equal(lineLoginEnabled(), false);
    assert.equal(demoModeEnabled(), true);
  } finally {
    restore(previous);
  }
});

test("a non-production demo still accepts 123456 and warns", () => {
  const previous = env();
  const lines: string[] = [];
  const warn = console.warn;
  console.warn = (message?: unknown) => {
    lines.push(String(message));
  };
  try {
    delete process.env.CONDOLA_ENV;
    delete process.env.NEXT_PHASE;
    setEnv("NODE_ENV", "development");
    process.env.DEMO_MODE = "true";
    assert.equal(demoModeEnabled(), true);
    assert.equal(acceptSecondFactor(secret, "123456", at), true);
    assert.equal(acceptSecondFactor(secret, "000000", at), false);
    enforceDemoSafety();
    assert.match(lines.join("\n"), /DEMO_MODE is ON/);
  } finally {
    console.warn = warn;
    restore(previous);
  }
});

test("demo LINE copy is live-hidden and shown for DEMO_MODE or a sandbox firm", () => {
  const previous = env();
  try {
    delete process.env.CONDOLA_ENV;
    delete process.env.NEXT_PHASE;
    setEnv("NODE_ENV", "development");
    delete process.env.DEMO_MODE;
    assert.equal(showDemoLineCopy("live"), false);
    assert.equal(showDemoLineCopy("sandbox"), true);
    assert.equal(showDemoLineCopy(null), false);

    process.env.DEMO_MODE = "true";
    assert.equal(showDemoLineCopy("live"), false);
    assert.equal(showDemoLineCopy("sandbox"), true);
    assert.equal(showDemoLineCopy(null), true);

    process.env.CONDOLA_ENV = "staging";
    assert.equal(demoModeEnabled(), false);
    assert.equal(showDemoLineCopy("live"), false);
    assert.equal(showDemoLineCopy("sandbox"), true);
    assert.equal(showDemoLineCopy(null), false);
  } finally {
    restore(previous);
  }

  const zh = JSON.parse(readFileSync(new URL("../i18n/zh-TW.json", import.meta.url), "utf8")) as Record<string, string>;
  const en = JSON.parse(readFileSync(new URL("../i18n/en.json", import.meta.url), "utf8")) as Record<string, string>;
  assert.equal(zh.i_notify_empty, "目前沒有通知");
  assert.equal(en.i_notify_empty, "No notifications right now.");
  assert.equal(zh.i_notify_empty.includes("LINE"), false);
  assert.equal(en.i_notify_empty.includes("LINE"), false);
  assert.equal(zh.i_notify_empty.includes("已送出"), false);
  assert.equal(zh.i_notify_empty.includes("已寄出"), false);

  const tenant = readFileSync(new URL("../app/t/layout.tsx", import.meta.url), "utf8");
  const notify = readFileSync(new URL("../app/m/notify/page.tsx", import.meta.url), "utf8");
  const account = readFileSync(new URL("../app/m/account/page.tsx", import.meta.url), "utf8");
  const settings = readFileSync(new URL("../app/m/settings/page.tsx", import.meta.url), "utf8");
  const login = readFileSync(new URL("../app/login/page.tsx", import.meta.url), "utf8");
  assert.doesNotMatch(tenant, /i_line_stub|showDemoLineCopy|line-stub|LINE 登入與推播/);
  assert.doesNotMatch(account, /showDemoLineCopy|LINE/);
  assert.doesNotMatch(settings, /LINE/);
  assert.match(login, /showDemoLineCopy\(null\)/);
  assert.match(notify, /i_notify_empty/);
  assert.doesNotMatch(notify, /i_line_stub/);
  assert.doesNotMatch(notify, /showDemoLineCopy/);

  const unused = ["s_26e8a90", "s_a24063a"];
  const hits: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === "node_modules") continue;
        walk(path);
        continue;
      }
      if (!/\.(ts|tsx)$/.test(entry.name)) continue;
      const text = readFileSync(path, "utf8");
      for (const key of unused) {
        if (text.includes(key)) hits.push(`${path} ${key}`);
      }
    }
  };
  walk(new URL("../app", import.meta.url).pathname);
  walk(new URL("../components", import.meta.url).pathname);
  assert.deepEqual(hits, []);
});

test("live screens do not render LINE product copy, including the app footer", () => {
  const zh = JSON.parse(readFileSync(new URL("../i18n/zh-TW.json", import.meta.url), "utf8")) as Record<string, string>;
  const en = JSON.parse(readFileSync(new URL("../i18n/en.json", import.meta.url), "utf8")) as Record<string, string>;
  assert.equal(zh.i_login_sub_live, "給屋主與合法代管公司使用的租賃管理軟體。");
  assert.equal(en.i_login_sub_live, "Rental management software for owners and licensed firms.");
  assert.equal(zh.i_notify_empty.includes("LINE"), false);
  assert.equal(en.i_notify_empty.includes("LINE"), false);
  const mixed = `軟體說明。租客用 LINE 就能查帳單。${LINE_SUPPORT_CONTACT}`;
  assert.equal(appFooterText(mixed, false), `軟體說明。${LINE_SUPPORT_CONTACT}`);
  assert.equal(appFooterText(mixed, true), mixed);
  assert.equal(appFooterText(LINE_SUPPORT_CONTACT, false), LINE_SUPPORT_CONTACT);
  for (const key of ["i_footer", "i_login_footer", "i_price_footer"]) {
    for (const catalog of [zh, en]) {
      const live = appFooterText(catalog[key], false);
      assert.equal(live.split(LINE_SUPPORT_CONTACT).join("").includes("LINE"), false, key);
    }
  }
  assert.match(zh.i_w7, /租客在 LINE 收到邀請/);
  assert.match(zh.i_invite_help, /LINE 官方帳號/);
  assert.equal(zh.s_9f8fee8, "LINE 官方帳號");

  const lineKeys = Object.keys(zh).filter((key) => {
    const zhText = typeof zh[key] === "string" ? zh[key] : "";
    const enText = typeof en[key] === "string" ? en[key] : "";
    return zhText.includes("LINE") || enText.includes("LINE");
  });
  const ungated: string[] = [];
  const nearGate = (source: string, index: number) => {
    const window = source.slice(Math.max(0, index - 800), index + 160);
    return /showDemoLineCopy|\bdemoLine\b|\bshowLine\b|appFooterText|environment === "sandbox"/.test(window);
  };
  const scan = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === "node_modules") continue;
        scan(path);
        continue;
      }
      if (!/\.(ts|tsx)$/.test(entry.name)) continue;
      const text = readFileSync(path, "utf8");
      if (text.includes("i_line_login_todo")) ungated.push(`${path} still renders i_line_login_todo`);
      if (text.includes("i_w${")) {
        if (!text.includes("showDemoLineCopy") || !text.includes('includes("LINE")')) {
          ungated.push(`${path} renders walk steps without a LINE filter`);
        }
      }
      for (const key of lineKeys) {
        const needle = `"${key}"`;
        let from = 0;
        while (from < text.length) {
          const at = text.indexOf(needle, from);
          if (at < 0) break;
          if (!nearGate(text, at)) ungated.push(`${path} ${key}`);
          from = at + needle.length;
        }
      }
      const lineWord = /LINE/g;
      let match: RegExpExecArray | null;
      while ((match = lineWord.exec(text))) {
        const lineStart = text.lastIndexOf("\n", match.index) + 1;
        const lineEnd = text.indexOf("\n", match.index);
        const line = text.slice(lineStart, lineEnd === -1 ? text.length : lineEnd).trim();
        if (line.startsWith("//") || line.startsWith("*") || line.startsWith("/*")) continue;
        if (!nearGate(text, match.index)) ungated.push(`${path} hardcoded LINE`);
      }
    }
  };
  scan(new URL("../app", import.meta.url).pathname);
  scan(new URL("../components", import.meta.url).pathname);

  const login = readFileSync(new URL("../app/login/page.tsx", import.meta.url), "utf8");
  assert.match(login, /demoLine \? t\("i_login_sub"\) : t\("i_login_sub_live"\)/);
  assert.match(login, /demoLine && lineLoginEnabled\(\)/);
  assert.equal((login.match(/data-testid="line-login"/g) ?? []).length, 1);
  assert.doesNotMatch(login, /disabled[^>\n]*line-login|line-login"[^>\n]*disabled/);
  const account = readFileSync(new URL("../app/m/account/page.tsx", import.meta.url), "utf8");
  const settings = readFileSync(new URL("../app/m/settings/page.tsx", import.meta.url), "utf8");
  assert.doesNotMatch(account, /LINE/);
  assert.doesNotMatch(settings, /LINE/);
  const accept = readFileSync(new URL("../app/accept/[token]/page.tsx", import.meta.url), "utf8");
  assert.match(accept, /showDemoLineCopy\(null\) && lineLoginEnabled\(\)/);
  const walk = readFileSync(new URL("../app/walk/page.tsx", import.meta.url), "utf8");
  assert.match(walk, /demoLine \|\| !step\.includes\("LINE"\)/);
  assert.equal(ungated.some((hit) => hit.includes("i_invite_help") || hit.includes("s_9f8fee8")), false);
  assert.deepEqual(ungated, []);
});
