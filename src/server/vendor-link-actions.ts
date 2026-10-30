"use server";

import { requireCurrentConsent } from "./consent-gate";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { FlowError } from "./errors";
import { isUuid } from "./repair-rules";
import { getSession } from "./session";
import { approveVendorSharing } from "./vendor-repair";

export async function actionApproveVendorSharing(formData: FormData) {
  await requireCurrentConsent();
  const ticketId = String(formData.get("ticketId") ?? "");
  const back = isUuid(ticketId) ? `/m/tickets/${ticketId}` : "/m/tickets";
  try {
    const session = await getSession();
    await approveVendorSharing(session, ticketId, String(formData.get("jobId") ?? ""), {
      description: String(formData.get("description") ?? ""),
      attachmentIds: formData.getAll("attachmentIds").map(String),
    });
    revalidatePath(back);
  } catch (error) {
    if (typeof error === "object" && error !== null && "digest" in error &&
        String(error.digest).startsWith("NEXT_REDIRECT")) throw error;
    const key = error instanceof FlowError ? error.key : "errors.generic";
    if (key === "errors.generic") console.error("sharing approval failed");
    redirect(`${back}?error=${encodeURIComponent(key)}`);
  }
  redirect(back);
}
