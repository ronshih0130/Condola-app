import React from "react";
import type { Locale } from "../../../../i18n";
import { brandV3TeamCopy } from "../../../../i18n/lanes/brand-v3-r5-team";

/** The 2FA switch row (role="switch"); the client wrapper saves it. While saving it is aria-disabled. */
export function TeamSecurityRow({ locale, required, saving = false, error = false, onToggle }: {
  locale: Locale; required: boolean; saving?: boolean; error?: boolean; onToggle?: () => void;
}) {
  const c = brandV3TeamCopy(locale);
  return <div className="v3-team-switches" aria-busy={saving || undefined}>
    <div className="v3-team-swr">
      <span className="v3-team-swtext"><b id="v3-team-2fa">{c.require2fa}</b><span className="v3-team-sub" id="v3-team-2fa-sub">{c.require2faSub}</span></span>
      <button type="button" role="switch" className="v3-team-switch" aria-checked={required} aria-labelledby="v3-team-2fa"
        aria-describedby="v3-team-2fa-sub" aria-disabled={saving || undefined} onClick={onToggle}>
        <span className="v3-team-knob" aria-hidden="true" />
      </button>
    </div>
    {error && <p className="v3-team-error" role="alert">{c.saveFailed}</p>}
  </div>;
}
