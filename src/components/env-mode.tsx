"use client";

import { usePathname } from "next/navigation";
import { useState } from "react";
import { actionGoLive } from "@/server/env-actions";
import { PendingSubmit } from "./pending-submit";
import { useT } from "./locale";

export function EnvBanner({ showBack }: { showBack: boolean }) {
  const t = useT();
  const path = usePathname() || "/m";
  const href = `/api/env?set=live&next=${encodeURIComponent(path)}`;
  return (
    <div className="env-banner" id="envBanner" data-testid="env-banner" role="status">
      <b>{t("i_sandbox_banner")}</b>
      {showBack ? (
        <a href={href} data-testid="env-banner-live">
          {t("i_sandbox_back")}
        </a>
      ) : null}
    </div>
  );
}

export function GoLiveForm({
  allowed,
  activeUnits,
  freeUnits,
  canCopy,
  liveEnabled,
}: {
  allowed: boolean;
  activeUnits: number;
  freeUnits: number;
  canCopy: boolean;
  liveEnabled: boolean;
}) {
  const t = useT();
  const [copy, setCopy] = useState(canCopy);
  return (
    <form action={actionGoLive} className="col" data-testid="golive-form">
      <div id="glReq" data-testid="gl-req" data-allowed={allowed ? "true" : "false"} data-units={activeUnits}>
        {allowed ? (
          <div className="alert ok">{t("i_golive_req_ok", { n: activeUnits, free: freeUnits })}</div>
        ) : (
          <div className="alert warn" data-testid="gl-blocked">
            <div>
              <p>{t("i_golive_blocked", { free: freeUnits })}</p>
              <a href="/m/upgrade" data-testid="gl-upgrade">
                {t("i_golive_upgrade")}
              </a>
            </div>
          </div>
        )}
      </div>
      <label className="radio">
        <input
          id="glCopy"
          data-testid="gl-copy"
          name="copy"
          type="checkbox"
          checked={copy}
          disabled={!canCopy}
          onChange={(event) => setCopy(event.target.checked)}
        />
        <span>
          <b>{t("i_golive_copy")}</b>
        </span>
      </label>
      {copy ? (
        <ul id="glCopyList" data-testid="gl-copy-list">
          <li>{t("i_golive_settings")}</li>
          <li>{t("i_golive_properties")}</li>
          <li>{t("i_golive_owners")}</li>
          <li>{t("i_golive_fees")}</li>
          <li>{t("i_golive_banks")}</li>
          <li>{t("i_golive_invites")}</li>
        </ul>
      ) : (
        <p id="glNoCopy" data-testid="gl-no-copy">
          {t("i_golive_no_copy")}
        </p>
      )}
      <p id="glOwners" data-testid="gl-owners">
        {t("i_golive_owners_note")}
      </p>
      <div id="glNever" data-testid="gl-never" className="card pad">
        <b>{t("i_golive_never_title")}</b>
        <p>{t("i_golive_never_items")}</p>
        <p className="small muted">{t("i_golive_never_reason")}</p>
      </div>
      {liveEnabled ? null : (
        <p data-testid="gl-live-locked">{t("i_live_locked")}</p>
      )}
      <PendingSubmit
        className="btn pri"
        idle={t("i_golive_start")}
        pending={t("i_golive_pending")}
        testId="gl-confirm"
        disabled={!allowed || !liveEnabled}
        style={{ opacity: 1 }}
      />
    </form>
  );
}
