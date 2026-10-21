"use server";

import { redirect } from "next/navigation";
import { PortfolioError, seedPortfolio } from "./portfolio";
import { getSession } from "./session";

export async function actionImportCsv(formData: FormData) {
  const file = formData.get("file");
  if (!(file instanceof File) || file.size === 0) redirect("/m/import?error=required");
  const csv = await file.text();
  try {
    const session = await getSession();
    await seedPortfolio(session, csv);
  } catch (error) {
    if (error instanceof PortfolioError) redirect("/m/import?error=rows");
    redirect("/m/import?error=generic");
  }
  redirect("/m/properties");
}
