const REAL_ENVS = new Set(["production", "staging-real"]);

/**
 * A real deployment. `next build` / `next start` / Workers set NODE_ENV=production.
 * CONDOLA_ENV covers a staging project that must not keep the demo back doors.
 */
export function productionLikeEnv() {
  if (process.env.NODE_ENV === "production") return true;
  const name = process.env.CONDOLA_ENV?.trim().toLowerCase();
  return name !== undefined && REAL_ENVS.has(name);
}

export function demoModeRequested() {
  return process.env.DEMO_MODE === "true";
}

/** True only for a local/dev demo. Production and staging-real ignore DEMO_MODE. */
export function demoModeEnabled() {
  return demoModeRequested() && !productionLikeEnv();
}

function building() {
  return process.env.NEXT_PHASE === "phase-production-build";
}

let warned = false;

export function warnDemoMode() {
  if (warned || !demoModeEnabled()) return;
  warned = true;
  console.warn(
    [
      "!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!",
      "DEMO_MODE is ON.",
      "The authenticator accepts 123456 and POST /api/demo/reset can wipe the database.",
      "Never set DEMO_MODE when NODE_ENV=production or CONDOLA_ENV is production or staging-real.",
      "!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!",
    ].join("\n"),
  );
}

/**
 * Call once when the server starts. A real environment that still has
 * DEMO_MODE=true does not boot. `next build` only ignores the flag so the
 * bundle can be produced from a demo .env.local.
 */
export function enforceDemoSafety() {
  if (building()) return;
  if (demoModeRequested() && productionLikeEnv()) {
    const message =
      "Refusing to start: DEMO_MODE=true while NODE_ENV=production or CONDOLA_ENV is production/staging-real. Unset DEMO_MODE. The TOTP bypass and demo reset stay off.";
    console.error(`\n${"!".repeat(72)}\n${message}\n${"!".repeat(72)}\n`);
    throw new Error(message);
  }
  warnDemoMode();
}

/**
 * LINE Login is not a real OAuth client. When enabled it signs in the member
 * whose profile is marked line-linked (the prototype behavior). Default follows
 * DEMO_MODE. Set LINE_LOGIN_ENABLED=false to hide it even in the demo.
 */
export function lineLoginEnabled() {
  if (process.env.LINE_LOGIN_ENABLED === "false") return false;
  if (process.env.LINE_LOGIN_ENABLED === "true") return true;
  return demoModeEnabled();
}
