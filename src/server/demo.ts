/** Destructive demo routes stay off unless this is exactly the string "true". */
export function demoModeEnabled() {
  return process.env.DEMO_MODE === "true";
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
