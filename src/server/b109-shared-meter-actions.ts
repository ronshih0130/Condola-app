"use server";

import { requireCurrentConsent } from "./consent-gate";
import { saveSharedMeter, type SharedMeterInput, type SharedMeterResult } from "./b109-shared-meter";
import { getSession } from "./session";

/** ADV-METER 「儲存」 (MGT-90-AC4/AC6). saveSharedMeter applies guardEffectiveSession + props.edit. */
export async function saveSharedMeterAction(input: SharedMeterInput): Promise<SharedMeterResult> {
  await requireCurrentConsent();
  return saveSharedMeter(await getSession(), input);
}
