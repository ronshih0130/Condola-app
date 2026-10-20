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

export function lineLoginRequested() {
  return process.env.LINE_LOGIN_ENABLED === "true";
}

/**
 * Call once when the server starts. A real environment that still has
 * DEMO_MODE or LINE_LOGIN_ENABLED set does not boot. `next build` only
 * ignores the flags so the bundle can be produced from a demo .env.local.
 */
export function enforceDemoSafety() {
  if (building()) return;
  if (productionLikeEnv() && (demoModeRequested() || lineLoginRequested())) {
    const message =
      "Refusing to start: DEMO_MODE or LINE_LOGIN_ENABLED is true while NODE_ENV=production or CONDOLA_ENV is production/staging-real. Unset both. The TOTP bypass, demo reset, and demo LINE sign-in stay off.";
    console.error(`\n${"!".repeat(72)}\n${message}\n${"!".repeat(72)}\n`);
    throw new Error(message);
  }
  warnDemoMode();
  if (lineLoginEnabled()) {
    console.warn("DEMO LINE LOGIN is ON. It signs in the linked member with no password and no 2FA. It does not call LINE.");
  }
}

/**
 * LINE Login is not a real OAuth client. When enabled it signs in the member
 * whose profile is marked line-linked, with no password. It follows the same
 * production guard as DEMO_MODE: ignored, and the process refuses to start,
 * when NODE_ENV=production or CONDOLA_ENV is production or staging-real.
 */
export function lineLoginEnabled() {
  if (productionLikeEnv()) return false;
  if (process.env.LINE_LOGIN_ENABLED === "false") return false;
  if (process.env.LINE_LOGIN_ENABLED === "true") return true;
  return demoModeEnabled();
}
