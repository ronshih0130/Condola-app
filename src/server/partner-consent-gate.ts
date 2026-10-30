import { redirect } from "next/navigation";
import type { Session } from "./types";
import { readPartnerState } from "./partner-consent";

export async function requirePartnerConsent(
  session: Session,
  mode: "api" | "action" | "page" = "action",
): Promise<Response | null> {
  if (session.kind !== "staff") return null;
  const state = session.partnerConsent ?? await readPartnerState(session);
  if (!state.required) return null;
  if (mode === "api") {
    return Response.json(
      { ok: false, error: "errors.consentRequired" },
      { status: 403, headers: { "Cache-Control": "private, no-store" } },
    );
  }
  redirect("/partner-consent");
}
