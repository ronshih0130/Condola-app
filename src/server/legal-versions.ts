/**
 * Effective dates printed on the legal pages (生效日期).
 * Signup stores these on the auth user. The legal markdown stays the source text;
 * signup-consent tests fail if a page's 生效日期 moves without this constant.
 */
export const TERMS_VERSION = "2026-10-22";
export const PRIVACY_VERSION = "2026-10-27";

export type SignupConsentMetadata = {
  terms_accepted_at: string;
  terms_version: string;
  privacy_version: string;
};

/** Server clock only. Callers must not accept a client-supplied timestamp. */
export function signupConsentMetadata(acceptedAt: Date = new Date()): SignupConsentMetadata {
  return {
    terms_accepted_at: acceptedAt.toISOString(),
    terms_version: TERMS_VERSION,
    privacy_version: PRIVACY_VERSION,
  };
}

/**
 * GoTrue REST signup body. `data` is stored as user metadata.
 * `options.data` is the same object the Supabase JS client sends through that field.
 */
export function signupRequestBody(email: string, password: string, metadata: SignupConsentMetadata) {
  return {
    email,
    password,
    data: metadata,
    options: { data: metadata },
  };
}
