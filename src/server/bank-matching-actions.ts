"use server";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requireCurrentConsent } from "./consent-gate";
import { getSession } from "./session";
import { decideBankMatch, importBankFile } from "./bank-matching";

export async function actionImportBankFile(form: FormData) {
  await requireCurrentConsent();
  const session = await getSession();
  try {
    const file = form.get("file"), encoding = form.get("encoding"), account = form.get("account"), dateFormat = form.get("dateFormat");
    if (!(file instanceof File) || file.size > 1_000_000 || typeof account !== "string" || (encoding !== "utf-8" && encoding !== "big5") || (dateFormat !== "iso" && dateFormat !== "roc")) throw new Error("Invalid input");
    const result = await importBankFile(session,account,new Uint8Array(await file.arrayBuffer()),encoding,dateFormat);
    if (!result) throw new Error("Unavailable");
  } catch { redirect("/m/bank?error=errors.generic"); }
  revalidatePath("/m/bank");
}
export async function actionDecideBankMatch(form: FormData) {
  await requireCurrentConsent();
  const session = await getSession();
  try {
    const decision = form.get("decision"), bankId = form.get("bankId"), reason = form.get("reason"), payment = form.get("paymentId"), suggestion = form.get("suggestionId");
    if ((decision !== "match" && decision !== "reject") || typeof bankId !== "string" || typeof reason !== "string") throw new Error("Invalid input");
    const result = await decideBankMatch(session,{decision,bankId,reason,paymentId:typeof payment === "string" && payment ? payment : undefined,suggestionId:typeof suggestion === "string" && suggestion ? suggestion : undefined});
    if (!result) throw new Error("Unavailable");
  } catch { redirect("/m/bank?error=errors.generic"); }
  revalidatePath("/m/bank");
}
