"use client";

import { useEffect, useRef, useState } from "react";
import { usePathname } from "next/navigation";
import { errorText } from "@/i18n/errors";
import { actionCreateTeamInviteLink } from "@/server/auth-actions";
import { useT } from "./locale";
import { TeamInviteLinkDisplay, type TeamInviteLink } from "./team-invite-link-button";

export function TeamInviteForm() {
  const t = useT();
  const pathname = usePathname();
  const [link, setLink] = useState<TeamInviteLink | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const generation = useRef(0);

  useEffect(() => {
    generation.current += 1;
    setLink(null);
    setError("");
    setBusy(false);
    function clear() {
      generation.current += 1;
      setLink(null);
    }
    window.addEventListener("pagehide", clear);
    return () => {
      generation.current += 1;
      window.removeEventListener("pagehide", clear);
    };
  }, [pathname]);

  return (
    <div className="card pad">
      <form onSubmit={async (event) => {
        event.preventDefault();
        if (busy) return;
        const form = event.currentTarget;
        const fields = new FormData(form);
        const current = ++generation.current;
        setBusy(true);
        setLink(null);
        setError("");
        try {
          const result = await actionCreateTeamInviteLink(fields);
          if (current !== generation.current) return;
          if (!result.ok) {
            setError(errorText(t, result.error));
            return;
          }
          setLink({ url: result.url, expiresAt: result.expiresAt, email: result.email });
          form.reset();
        } catch {
          if (current === generation.current) setError(t("i_generic"));
        } finally {
          if (current === generation.current) setBusy(false);
        }
      }}>
        <h3>{t("s_f320582")}</h3>
        {error ? <div className="alert bad" role="alert">{error}</div> : null}
        <div className="fg">
          <label className="f">{t("i_invite_email")}</label>
          <input className="inp" name="email" type="email" required data-testid="invite-email" placeholder={t("i_ph_email")} />
        </div>
        <div className="fg">
          <label className="f">{t("i_name")}</label>
          <input className="inp" name="name" data-testid="invite-name" />
        </div>
        <div className="fg">
          <label className="f">{t("i_role_label")}</label>
          <select className="inp" name="role" defaultValue="manager" data-testid="invite-role">
            <option value="manager">{t("i_role_manager")}</option>
            <option value="accountant">{t("i_role_accountant")}</option>
            <option value="maintenance">{t("i_role_maintenance")}</option>
            <option value="admin">{t("i_role_admin")}</option>
          </select>
          <div className="hint">{t("i_role_hint")}</div>
        </div>
        <button className="btn pri" type="submit" disabled={busy} aria-busy={busy || undefined}>{t("s_1af94ab")}</button>
        <p className="small muted">{t("i_team_invite_rotates")}</p>
      </form>
      {link ? <TeamInviteLinkDisplay link={link} /> : null}
    </div>
  );
}
