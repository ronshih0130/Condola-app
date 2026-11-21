"use client";
import { useEffect, useRef, useState } from "react";
import type { Locale } from "../../../../i18n";
import { TeamSecurityRow } from "./team-security-row";
import { afterSecuritySave, initialTeamSecurity, postTeamSecurity, startSecurityToggle, syncTeamSecurity } from "./team-security-state";

/**
 * R5-TEAM 全公司的安全規則 (MGT-133-AC7): a tap saves at once through POST /api/team-security (the existing
 * `setRequireMfa`). While it saves, taps are ignored. Any failure: back to the saved value with
 * 「沒有存成功，請再試一次。」.
 */
export function TeamSecuritySwitch({ locale, required }: { locale: Locale; required: boolean }) {
  const [state, setState] = useState(() => initialTeamSecurity(required));
  const busy = useRef(false);
  useEffect(() => { if (!busy.current) setState(current => syncTeamSecurity(current, required)); }, [required]);
  async function toggle() {
    if (busy.current) return;
    const next = startSecurityToggle(state);
    if (!next) return;
    busy.current = true;
    setState(next);
    const outcome = await postTeamSecurity(next.shown);
    setState(current => afterSecuritySave(current, outcome));
    busy.current = false;
  }
  return <TeamSecurityRow locale={locale} required={state.shown} saving={state.saving} error={state.error} onToggle={toggle} />;
}
