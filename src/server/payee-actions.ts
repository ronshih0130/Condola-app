"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { requireCurrentConsent } from "./consent-gate";
import { readSession } from "./session";
import { logPayeeIngress, readPayeeContext, savePayee, setLeasePayee } from "./payee";
import { authorizePayeeAction } from "./payee-action-context";

function text(form: FormData, key: string) {
  const value = form.get(key);
  return typeof value === "string" ? value.trim() : "";
}

function rethrowRedirect(error: unknown) {
  if (typeof error === "object" && error !== null && "digest" in error && String(error.digest).startsWith("NEXT_REDIRECT")) throw error;
}

async function context() {
  return authorizePayeeAction({
    readSession, readContext: readPayeeContext, audit: logPayeeIngress,
    requireConsent: (session) => requireCurrentConsent(session),
  });
}

export async function actionSavePayee(form: FormData) {
  let failed = false;
  try {
    await savePayee(await context(), {
      id: text(form, "id") || undefined, holderName: text(form, "holderName"),
      bankName: text(form, "bankName"), bankCode: text(form, "bankCode"),
      branchCode: text(form, "branchCode"), accountNumber: text(form, "accountNumber"),
      ownerContactId: text(form, "ownerContactId") || null, isDefault: form.get("isDefault") === "on",
      details: { swift: text(form, "swift"), routing: text(form, "routing") },
    });
  } catch (error) { rethrowRedirect(error); failed = true; }
  if (failed) redirect("/m/settings?error=invalid_payee");
  revalidatePath("/m/settings");
  revalidatePath("/t/pay");
  redirect("/m/settings?saved=1");
}

export async function actionSetLeasePayee(form: FormData) {
  let failed = false;
  try {
    await setLeasePayee(await context(), text(form, "leaseId") || null, text(form, "accountId") || null);
  } catch (error) { rethrowRedirect(error); failed = true; }
  if (failed) redirect("/m/settings?error=invalid_payee");
  revalidatePath("/m/settings");
  revalidatePath("/t/pay");
  redirect("/m/settings?saved=1");
}
