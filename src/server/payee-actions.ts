"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { savePayee, setLeasePayee } from "./payee";
import { authorizePayeeActionEntry } from "./payee-consent";

function text(form: FormData, key: string) {
  const value = form.get(key);
  return typeof value === "string" ? value.trim() : "";
}

function rethrowRedirect(error: unknown) {
  if (typeof error === "object" && error !== null && "digest" in error && String(error.digest).startsWith("NEXT_REDIRECT")) throw error;
}

export async function actionSavePayee(form: FormData) {
  const session = await authorizePayeeActionEntry();
  let failed = false;
  try {
    await savePayee(session, {
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
  const session = await authorizePayeeActionEntry();
  let failed = false;
  try {
    await setLeasePayee(session, text(form, "leaseId") || null, text(form, "accountId") || null);
  } catch (error) { rethrowRedirect(error); failed = true; }
  if (failed) redirect("/m/settings?error=invalid_payee");
  revalidatePath("/m/settings");
  revalidatePath("/t/pay");
  redirect("/m/settings?saved=1");
}
