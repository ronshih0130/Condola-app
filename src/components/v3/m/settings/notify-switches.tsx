"use client";
import { useEffect, useRef, useState } from "react";
import type { Locale } from "../../../../i18n";
import type { NotifyBlock, NotifyField, NotifyToggles } from "../../../../server/b073-notify-settings";
import { NotifySwitchRows } from "./notify";
import { afterNotifySave, initialNotifyState, postNotify, startNotifyToggle, syncNotify } from "./notify-state";

/**
 * R5-NOTIFY switches for one block (MGT-135-AC1/AC3/AC5): a tap saves at once through POST /api/notify-settings,
 * which writes only that switch's key. While it saves, the block's switches ignore taps. Any non-2xx or network
 * failure: back to the saved value with 「沒有存成功，請再試一次。」. Nothing is sent because of a save.
 */
export function NotifySwitches({ locale, block, toggles }: { locale: Locale; block: NotifyBlock; toggles: NotifyToggles }) {
  const [state, setState] = useState(() => initialNotifyState(toggles));
  const busy = useRef(false);
  useEffect(() => { if (!busy.current) setState(current => syncNotify(current, toggles)); }, [toggles]);
  async function toggle(field: NotifyField) {
    if (busy.current) return;
    const next = startNotifyToggle(state, field);
    if (!next) return;
    busy.current = true;
    setState(next);
    const outcome = await postNotify(block, field, next.shown[field]);
    setState(current => afterNotifySave(current, outcome));
    busy.current = false;
  }
  return <NotifySwitchRows locale={locale} block={block} state={state} onToggle={toggle} />;
}
