import type { Session } from "./types";

/** The audit is awaited before a denial is surfaced, and receives no form data. */
export async function authorizePayeeAction<Context>(deps: {
  readSession: () => Promise<Session | null>;
  readContext: () => Promise<Context | null>;
  audit: (context: Context | Session | null) => Promise<void>;
  requireConsent: (session: Session) => Promise<unknown>;
}): Promise<Session> {
  const session = await deps.readSession();
  if (!session) {
    await deps.audit(await deps.readContext());
    throw new Error("Payee access unavailable");
  }
  try {
    await deps.requireConsent(session);
  } catch (error) {
    await deps.audit(session);
    throw error;
  }
  return session;
}
