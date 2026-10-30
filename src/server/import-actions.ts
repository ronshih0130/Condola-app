"use server";

import { requireCurrentConsent } from "./consent-gate";

import { redirect } from "next/navigation";
import { isRedirectError } from "next/dist/client/components/redirect-error";
import { PortfolioError, seedPortfolio } from "./portfolio";
import { getSession } from "./session";

export async function actionImportCsv(formData: FormData) {
  await requireCurrentConsent();
  const file = formData.get("file");
  if (!(file instanceof File) || file.size === 0) redirect("/m/import?error=required");
  const csv = await file.text();
  try {
    const session = await getSession();
    await seedPortfolio(session, csv);
  } catch (error) {
    if (isRedirectError(error)) throw error;
    if (error instanceof PortfolioError) redirect("/m/import?error=rows");
    redirect("/m/import?error=generic");
  }
  redirect("/m/properties");
}
