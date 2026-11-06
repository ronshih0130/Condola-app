export type LineEnv = Record<string, string | undefined>;
export function readLineConfig(env: LineEnv = process.env) {
  const raw = env.LINE_PUSH_MONTHLY_LIMIT;
  const limit = raw === undefined ? 180 : /^[0-9]+$/.test(raw) ? Number(raw) : NaN;
  const validLimit = Number.isSafeInteger(limit) && limit >= 1 && limit <= 180;
  return {
    platformEnabled: env.LINE_PLATFORM_ENABLED === "true",
    // Protection defaults ON. An absent/invalid switch is NOT permission to send.
    // Explicit true (or the hub's documented ON) establishes a healthy guard; disabling never bypasses it.
    guardEnabled: true as const,
    guardReady: validLimit && (env.LINE_PUSH_QUOTA_GUARD === "true" || env.LINE_PUSH_QUOTA_GUARD === "ON"),
    monthlyLimit: validLimit ? limit : null,
  };
}
