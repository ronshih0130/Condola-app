"use client";

import Link from "next/link";
import { useState, type CSSProperties } from "react";
import { actionGoLive } from "@/server/env-actions";
import type { OrgEnvironment } from "@/server/org-scope";
import { useT } from "./locale";

export function EnvSwitch({ environment, liveEnabled }: { environment: OrgEnvironment; liveEnabled: boolean }) {
  const t = useT();
  const sandbox = environment === "sandbox";
  const long = sandbox ? t("i_env_test") : t("i_env_live");
  const short = sandbox ? t("i_env_test_short") : t("i_env_live_short");
  const [menu, setMenu] = useState<CSSProperties | null>(null);
  return (
    <div className="env-switch" id="envSwitch">
      <button
        type="button"
        className="env-toggle"
        data-testid="env-switch"
        aria-label={t("i_env_menu")}
        aria-expanded={menu ? true : false}
        onClick={(event) => {
          if (menu) {
            setMenu(null);
            return;
          }
          const rect = event.currentTarget.getBoundingClientRect();
          setMenu({ top: rect.bottom + 6, left: Math.max(8, rect.left) });
        }}
      >
        <span className="env-long">{long}</span>
        <span className="env-short">{short}</span>
        <span aria-hidden="true"> ▾</span>
      </button>
      {menu ? (
      <div className="env-menu" id="envMenu" data-testid="env-menu" style={menu}>
        {liveEnabled ? (
          <a href="/api/env?set=live&next=/m" data-testid="env-pick-live">
            <b>{t("i_env_live")}</b>
            <small>{t("i_env_live_hint")}</small>
          </a>
        ) : (
          <span className="env-pick-disabled" data-testid="env-pick-live" aria-disabled="true">
            <b>{t("i_env_live")}</b>
            <small>{t("i_live_locked")}</small>
          </span>
        )}
        <a href="/api/env?set=sandbox&next=/m" data-testid="env-pick-sandbox">
          <b>{t("i_env_test")}</b>
          <small>{t("i_env_test_hint")}</small>
        </a>
        {sandbox ? (
          <a href="/m/env" data-testid="env-go-live">
            <b>{t("i_env_to_live")}</b>
          </a>
        ) : null}
      </div>
      ) : null}
    </div>
  );
}

export function EnvBanner() {
  const t = useT();
  return (
    <div className="env-banner" id="envBanner" data-testid="env-banner" role="status">
      <span>
        🧪 <b>{t("i_env_banner_title")}</b>
      </span>
      <span>{t("i_env_banner_body")}</span>
      <Link href="/m/env" data-testid="env-banner-live">
        {t("i_golive_start")} →
      </Link>
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
              <a href={`/api/env?set=live&next=${encodeURIComponent("/m/settings?upgrade=1")}`} data-testid="gl-upgrade">
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
      <button className="btn pri" type="submit" data-testid="gl-confirm" disabled={!allowed || !liveEnabled}>
        {t("i_golive_start")}
      </button>
    </form>
  );
}
