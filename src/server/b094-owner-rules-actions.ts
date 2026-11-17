"use server";

import { guardEffectiveSession } from "@/server/b017-custom-role-governance";
import { setOwnerRule, type SetOwnerRuleInput } from "./b091-owner-rules";
import { requireCurrentConsent } from "./consent-gate";
import { getSession } from "./session";

/** B-094 RO-RULES: a choice saves (no solid primary). The B-091 gateway repeats every admission. */
export async function setOwnerRuleAction(input: SetOwnerRuleInput) {
  await requireCurrentConsent();
  return setOwnerRule(await guardEffectiveSession(await getSession(), null), input);
}
