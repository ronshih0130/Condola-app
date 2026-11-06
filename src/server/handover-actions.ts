"use server";

import { guardEffectiveSession } from "@/server/b017-custom-role-governance";
import { revalidatePath } from "next/cache";
import { requireCurrentConsent } from "./consent-gate";
import { publishHandover, replyHandover } from "./handover";
import { getSession } from "./session";

export async function publishHandoverAction(leaseId: string, phase: string, expected: string, form: FormData) {
  await requireCurrentConsent();
  const session = await guardEffectiveSession(await getSession(), "leases.edit");
  try {
    await publishHandover(session, leaseId, phase, String(form.get("note") ?? ""), expected || null);
    revalidatePath(`/m/handover/${leaseId}`); revalidatePath(`/t/handover/${leaseId}`);
    return { ok:true } as const;
  } catch { return { ok:false } as const; }
}
export async function replyHandoverAction(leaseId: string, version: string, requestId: string, form: FormData) {
  await requireCurrentConsent();
  const session = await guardEffectiveSession(await getSession(), "leases.edit");
  try {
    await replyHandover(session, leaseId, version, String(form.get("response") ?? ""), String(form.get("note") ?? ""), requestId);
    revalidatePath(`/m/handover/${leaseId}`); revalidatePath(`/t/handover/${leaseId}`);
    return { ok:true } as const;
  } catch { return { ok:false } as const; }
}
