"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { FlowError } from "./errors";
import { getSession } from "./session";
import { saveKeptUnits } from "./unit-limit-store";

function isRedirect(error: unknown) {
  return (
    typeof error === "object" &&
    error !== null &&
    "digest" in error &&
    String((error as { digest?: string }).digest).startsWith("NEXT_REDIRECT")
  );
}

export async function actionSaveKeptUnits(formData: FormData) {
  try {
    const session = await getSession();
    const ids = formData.getAll("spaceId").map((value) => String(value));
    await saveKeptUnits(session, ids);
    revalidatePath("/m/units");
    redirect("/m/units?saved=kept");
  } catch (error) {
    if (isRedirect(error)) throw error;
    const key = error instanceof FlowError ? error.key : "errors.generic";
    redirect(`/m/units?error=${encodeURIComponent(key)}`);
  }
}
