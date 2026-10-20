import assert from "node:assert/strict";
import test from "node:test";
import { demoModeEnabled, enforceDemoSafety } from "./demo";
import { acceptSecondFactor } from "./totp";

const secret = "JBSWY3DPEHPK3PXP";
const at = Date.parse("2026-10-20T08:00:00Z");

function env() {
  return {
    DEMO_MODE: process.env.DEMO_MODE,
    NODE_ENV: process.env.NODE_ENV,
    CONDOLA_ENV: process.env.CONDOLA_ENV,
    NEXT_PHASE: process.env.NEXT_PHASE,
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
    for (const flag of ["production", "staging-real"]) {
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
