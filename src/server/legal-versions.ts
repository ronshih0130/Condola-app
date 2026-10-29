/**
 * Effective dates printed on the legal pages (生效日期).
 * Signup stores these on the auth user. The legal markdown stays the source text;
 * signup-consent tests fail if a page's 生效日期 moves without this constant.
 */
export const TERMS_VERSION = "2026-10-22";
// Privacy v2.1. TODO(PE deploy): set to the actual ship date (YYYY-MM-DD) with
// /workspace/condola-hub/10-pipeline/copy-batch-1102/set-privacy-ship-date.py; it also updates the
// privacy.md 生效日期 header and §11 revision date, config/partner-consent-documents.json and the legal.test.ts pin.
// v2 (2026-10-27) text is kept unchanged at content/legal/archive/privacy-v2-2026-10-27.md.
export const PRIVACY_VERSION = "2026-10-29";

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
