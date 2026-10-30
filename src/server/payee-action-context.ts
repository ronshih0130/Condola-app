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

export async function authorizePayeeApi<Context>(deps: {
  readSession: () => Promise<Session | null>;
  readContext: () => Promise<Context | null>;
  audit: (context: Context | Session | null) => Promise<void>;
  requireConsent: (session: Session) => Promise<Response | null>;
}): Promise<{ ok: true; session: Session } | { ok: false; response: Response }> {
  try {
    const session = await deps.readSession();
    if (!session) {
      await deps.audit(await deps.readContext());
      return { ok: false, response: Response.json({ ok: false }, { status: 401, headers: { "Cache-Control": "private, no-store" } }) };
    }
    let denial: Response | null;
    try { denial = await deps.requireConsent(session); }
    catch (error) { await deps.audit(session); throw error; }
    if (denial) {
      await deps.audit(session);
      return { ok: false, response: denial };
    }
    return { ok: true, session };
  } catch {
    return { ok: false, response: Response.json({ ok: false }, {
      status: 503, headers: { "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff" },
    }) };
  }
}
