"use server";

import { guardEffectiveSession } from "@/server/b017-custom-role-governance";
import type { RenewalInput } from "@/lib/renewal-comparison";
import { requireCurrentConsent } from "./consent-gate";
import { getSession } from "./session";
import { compareRenewal } from "./renewal-comparison";
export async function compareRenewalAction(leaseId:string,expected:string,input:RenewalInput) {
  await requireCurrentConsent();const session=await guardEffectiveSession(await getSession(), "leases.edit");return compareRenewal(session,leaseId,expected,input);
}
