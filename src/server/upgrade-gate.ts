import { readPartnerControls } from "./partner-controls";
import type { Session } from "./types";

/** The existing plan path is settings; /m is the neutral, price-free staff landing. */
export async function upgradeGate(session: Session, legacyUnitLimit: number, now = new Date()) {
  const controls = await readPartnerControls(session, now);
  return {
    redirectTo: controls.pricingHide ? "/m" as const : null,
    unitLimit: controls.unitOverride?.unitLimit ?? legacyUnitLimit,
    unitOverride: controls.unitOverride,
  };
}
