"use client";

import { useEffect, useState } from "react";
import { errorText } from "@/i18n/errors";
import { actionAcceptTeamJoin, actionDescribeTeamJoin } from "@/server/auth-actions";
import { AuthBrand } from "./brand";
import { LegalConsentCheckbox } from "./consent-check";
import { PasswordFields } from "./password-field";
import { useT } from "./locale";

type Description = Awaited<ReturnType<typeof actionDescribeTeamJoin>>;

export function TeamJoin() {
  const t = useT();
  const [token, setToken] = useState("");
  const [description, setDescription] = useState<Description | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [agreed, setAgreed] = useState(false);
  const [consentError, setConsentError] = useState(false);

  useEffect(() => {
    setAgreed(false);
    setConsentError(false);
  }, [token]);

  useEffect(() => {
    let requestId = 0;

    function read() {
      const id = ++requestId;
      const fragment = new URLSearchParams(window.location.hash.slice(1));
      const captured = fragment.get("t") ?? "";
      window.history.replaceState(window.history.state, "", window.location.pathname);
      setToken(captured);
      setBusy(false);
      setError("");
      setDescription(captured ? null : { ok: false, error: "errors.teamInviteUnavailable" });
      if (!captured) return;
      void actionDescribeTeamJoin(captured).then(
        (result) => { if (id === requestId) setDescription(result); },
        () => {
          if (id === requestId) {
            setDescription({ ok: false, error: "errors.teamInviteUnavailable" });
          }
        },
      );
    }

    function clear() {
      ++requestId;
      setToken("");
      setBusy(false);
      setError("");
      setDescription({ ok: false, error: "errors.teamInviteUnavailable" });
    }

    window.addEventListener("hashchange", read);
    window.addEventListener("pagehide", clear);
    read();
    return () => {
      ++requestId;
      window.removeEventListener("hashchange", read);
      window.removeEventListener("pagehide", clear);
    };
  }, []);

  const account = (!description?.ok && description?.error === "account") || error === "account";
  const unavailable = error === "errors.teamInviteUnavailable" ||
    (description !== null && !description.ok && !account);
  const roleKeys: Record<string, string> = {
    admin: "i_role_admin",
    manager: "i_role_manager",
    accountant: "i_role_accountant",
    maintenance: "i_role_maintenance",
  };

  return (
    <div className="auth-wrap">
      <AuthBrand name={t("i_brand")} />
      <div className="card pad">
        <h1>{t("i_team_join_title")}</h1>
        {account ? (
          <>
            <div className="alert info" data-testid="team-account-mismatch">{t("i_team_invite_account")}</div>
            <form action="/api/auth/sign-out?next=/join" method="post">
              <button className="btn pri block" type="submit">{t("i_portal_sign_out_continue")}</button>
            </form>
          </>
        ) : unavailable ? (
          <div className="alert bad" data-testid="invite-state">{t("i_team_invite_unavailable")}</div>
        ) : description?.ok ? (
          <form key={token} data-testid="team-join-form" onInvalidCapture={() => {
            if (!agreed) setConsentError(true);
          }} onSubmit={async (event) => {
            event.preventDefault();
            if (busy) return;
            if (!agreed) {
              setConsentError(true);
              return;
            }
            setConsentError(false);
            const fields = new FormData(event.currentTarget);
            setBusy(true);
            setError("");
            try {
              const result = await actionAcceptTeamJoin({
                token,
                name: String(fields.get("name") ?? ""),
                password: String(fields.get("password") ?? ""),
                confirm: String(fields.get("confirm") ?? ""),
                consent: agreed,
              });
              setError(result.error);
            } catch (failure) {
              // Next redirects must propagate to its client action handler.
              if (typeof failure === "object" && failure !== null && "digest" in failure &&
                  String(failure.digest).startsWith("NEXT_REDIRECT")) throw failure;
              setError("errors.generic");
            } finally {
              setBusy(false);
            }
          }}>
            <p>{description.inviter} · {description.firm} · {t(roleKeys[description.role])}</p>
            <div className="fg">
              <label className="f">{t("i_invite_email")}</label>
              <input className="inp" type="email" value={description.email} readOnly autoComplete="off" />
            </div>
            {error ? <div className="alert bad" role="alert">{errorText(t, error)}</div> : null}
            <div className="fg">
              <label className="f">{t("i_name")}</label>
              <input className="inp" name="name" required autoComplete="name" data-testid="accept-name" />
            </div>
            <PasswordFields />
            <LegalConsentCheckbox
              variant="service"
              checked={agreed}
              onChange={setAgreed}
              showError={consentError && !agreed}
              labelTestId="invite-consent-label"
              inputTestId="invite-consent"
              termsTestId="invite-terms"
              privacyTestId="invite-privacy"
              errorTestId="invite-consent-error"
              errorKey="i_reconsent_error"
            />
            <button data-testid="accept-submit" className="btn pri block" type="submit" disabled={busy} aria-busy={busy || undefined}>
              {t(busy ? "i_portal_working" : "i_accept")}
            </button>
          </form>
        ) : <p role="status">{t("i_portal_working")}</p>}
      </div>
    </div>
  );
}
