"use client";
import { useEffect, useRef, useState } from "react";
import type { Locale } from "../../../../i18n";
import type { OwnerViewField } from "../../../../server/b073-owner-view";
import { saveOwnerViewAction } from "../../../../server/b073-owner-view-actions";
import type { OwnerPrivacy } from "../../../../server/privacy";
import { OwnerViewSwitchRows } from "./owner-view";
import { afterToggleSave, initialOwnerViewState, startToggle, syncOwnerView, type OwnerViewOutcome } from "./owner-view-state";

/**
 * R5-OWNVIEW switches (MGT-138-AC1/AC4): a tap saves at once through saveOwnerViewAction (a result, no redirect).
 * While it saves, both switches ignore taps (the action writes both keys). Failure: back to the saved value with
 * 「沒有存成功，請再試一次。」. Nothing is sent to owners.
 */
export function OwnerViewSwitches({ locale, privacy }: { locale: Locale; privacy: OwnerPrivacy }) {
  const [state, setState] = useState(() => initialOwnerViewState(privacy));
  const busy = useRef(false);
  useEffect(() => { if (!busy.current) setState(current => syncOwnerView(current, privacy)); }, [privacy]);
  async function toggle(field: OwnerViewField) {
    if (busy.current) return;
    const next = startToggle(state, field);
    if (!next) return;
    busy.current = true;
    setState(next);
    let outcome: OwnerViewOutcome;
    try { outcome = await saveOwnerViewAction({ field, value: next.shown[field] }); }
    catch { outcome = "threw"; }
    setState(current => afterToggleSave(current, outcome));
    busy.current = false;
  }
  return <OwnerViewSwitchRows locale={locale} state={state} onToggle={toggle} />;
}
