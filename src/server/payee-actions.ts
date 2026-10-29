"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { requireCurrentConsent } from "./consent-gate";
import { getSession } from "./session";
import { savePayee, setLeasePayee } from "./payee";

function text(form: FormData, key: string) {
  const value = form.get(key);
  return typeof value === "string" ? value.trim() : "";
}

export async function actionSavePayee(form: FormData) {
  await requireCurrentConsent();
  let failed = false;
  try {
    await savePayee(await getSession(), {
      id: text(form, "id") || undefined,
      holderName: text(form, "holderName"),
      bankName: text(form, "bankName"),
      bankCode: text(form, "bankCode"),
      branchCode: text(form, "branchCode"),
      accountNumber: text(form, "accountNumber"),
      ownerContactId: text(form, "ownerContactId") || null,
      isDefault: form.get("isDefault") === "on",
      details: { swift: text(form, "swift"), routing: text(form, "routing") },
    });
  } catch {
    failed = true;
  }
  if (failed) redirect("/m/settings?error=invalid_payee");
  revalidatePath("/m/settings");
  revalidatePath("/t/pay");
  redirect("/m/settings?saved=1");
}

export async function actionSetLeasePayee(form: FormData) {
  await requireCurrentConsent();
  let failed = false;
  try {
    await setLeasePayee(
      await getSession(), text(form, "leaseId"), text(form, "accountId") || null,
    );
  } catch {
    failed = true;
  }
  if (failed) redirect("/m/settings?error=invalid_payee");
  revalidatePath("/m/settings");
  revalidatePath("/t/pay");
  redirect("/m/settings?saved=1");
}
