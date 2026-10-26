/**
 * Login email for a 租客 contact that has no portal user yet.
 * Null means mint `portal-<uuid>@demo.condola.local` and do not use the contact email.
 * A taken address, including one that already belongs to another firm, is never reused.
 */
export function portalLoginEmail(input: {
  environment: "live" | "sandbox";
  contactEmail: string | null;
  emailTaken: boolean;
}) {
  if (input.environment === "sandbox" || input.emailTaken || !input.contactEmail) return null;
  return input.contactEmail.trim().toLowerCase();
}

/** Unique violation on auth.users.email. A contact-email index is a different error. */
export function authEmailTaken(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  const code = typeof error === "object" && error && "code" in error ? String((error as { code: unknown }).code) : "";
  if (code !== "23505" && !/duplicate key/i.test(message)) return false;
  if (/contacts_/i.test(message)) return false;
  return /email/i.test(message);
}
