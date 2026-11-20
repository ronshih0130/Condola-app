// PRINCIPLES 58: Changing this constant requires Ron's approval and a DECISIONS row.
export const SMS_PURPOSES = [
  "signup_verification",
  "contract_signing_otp",
  "phone_change_verification",
  "tenant_invite",
] as const;

export type SmsPurpose = (typeof SMS_PURPOSES)[number];

// CEO R3 (2026-11-19): Contract signing gets its own later slice; the other purposes are out of scope.
export const SLICE_ENABLED_PURPOSES: readonly SmsPurpose[] = ["signup_verification"];

export function isSlicePurpose(value: unknown): value is SmsPurpose {
  return typeof value === "string" && SLICE_ENABLED_PURPOSES.some((purpose) => purpose === value);
}
