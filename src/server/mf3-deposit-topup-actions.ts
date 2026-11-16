"use server";

import { requireCurrentConsent } from "./consent-gate";
import { recordDepositTopup, type TopupInput, type TopupResult } from "./mf3-deposit-topup";
import { getSession } from "./session";

/** MO-TOPUP 「記錄已收」 sheet submit (MGT-151-AC1/AC3/AC5). recordDepositTopup applies guardEffectiveSession + pay.record. */
export async function recordDepositTopupAction(input: TopupInput): Promise<TopupResult> {
  await requireCurrentConsent();
  return recordDepositTopup(await getSession(), input);
}
