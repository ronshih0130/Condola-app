import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { svc } from "./db";
import { FlowError } from "./errors";
import { getSession } from "./session";
import { partnerRequestMeta, recordPartnerConsentOn } from "./partner-consent";

/** Invoked by the existing, explicitly classified acceptance server action. */
export async function submitPartnerConsent(form: FormData): Promise<never> {
  const session = await getSession();
  if (session.kind !== "staff") redirect("/login");
  // A fresh session already evaluated integrity; do not report the same mismatch twice.
  if (!session.partnerConsent?.active) redirect("/m");
  const meta = partnerRequestMeta(await headers());
  try {
    await svc(session.userId, (client) =>
      recordPartnerConsentOn(client, session, form.get("partnerConsent") === "on", meta));
  } catch (error) {
    if (error instanceof FlowError && error.key === "errors.consentRequired") {
      redirect("/partner-consent?error=consent");
    }
    throw error;
  }
  redirect("/m");
}
