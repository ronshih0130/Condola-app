import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
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
  const login = readFileSync(new URL("../app/login/page.tsx", import.meta.url), "utf8");
  for (const source of [tenant, notify, account]) {
    assert.match(source, /showDemoLineCopy\(session\.environment\)/);
  }
  assert.match(login, /showDemoLineCopy\(null\)/);
  assert.match(notify, /i_notify_empty/);
  assert.match(notify, /demoLine \? \(/);

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
