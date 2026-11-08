import type { SecretResolver } from "./webhook";

/** Server-only entry point, imported only by the API route. No network or secret logging.
 * LINE_CHANNEL_SECRETS maps secret refs to {secret, identityPepper, destination}.
 */
export const resolveLocalLineSecret: SecretResolver = async ref => {
  try {
    const entries: unknown = JSON.parse(process.env.LINE_CHANNEL_SECRETS ?? "null");
    if (!entries || typeof entries !== "object" || Array.isArray(entries) || !Object.hasOwn(entries, ref)) return null;
    const value = (entries as Record<string, unknown>)[ref];
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    const { secret, identityPepper, destination } = value as Record<string, unknown>;
    if (![secret, identityPepper, destination].every(v => typeof v === "string" && v.trim().length > 0)) return null;
    return { secret: secret as string, identityPepper: identityPepper as string, destination: destination as string };
  } catch { return null; }
};
