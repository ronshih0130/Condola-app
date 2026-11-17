/**
 * B-091 renewal-rule values with no imports, so client components (B-094 RO-RULES) can use them without pulling
 * the server module (db, pg) into the browser bundle. b091-owner-rules.ts re-exports these.
 */
export const RENEWAL_RULES = ["delegate_notify", "delegate_unless_lower", "ask_every_time"] as const;
export type RenewalRule = (typeof RENEWAL_RULES)[number];
/** OWN-34-AC3: the default when the owner never chose. */
export const DEFAULT_RENEWAL_RULE: RenewalRule = "delegate_notify";
