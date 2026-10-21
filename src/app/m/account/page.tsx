import { cookies } from "next/headers";
import { makeT } from "@/i18n";
import { BackupCodes } from "@/components/backup-codes";
import { PasswordFields } from "@/components/password-field";
import { BACKUP_COOKIE, backupDisplay } from "@/server/backup";
import { ErrorBanner, PageHeader } from "@/components/ui";
import {
  actionBeginMfa,
  actionChangePassword,
  actionConfirmMfa,
  actionDisableMfa,
  actionEmailPrefs,
  actionRequireMfa,
  actionRevokeOthers,
  actionRevokeSession,
} from "@/server/auth-actions";
import { CHALLENGE_COOKIE, listSessions, mfaStatus, peekChallenge } from "@/server/auth";
import { lineLoginEnabled, showDemoLineCopy } from "@/server/demo";
import { memberEmailPrefs } from "@/server/mail-settings";
import { can } from "@/server/perms";
import { getSession } from "@/server/session";

export const dynamic = "force-dynamic";

export default async function AccountPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; saved?: string; enroll?: string; backup?: string }>;
}) {
  const session = await getSession();
  const t = makeT(session.locale);
  const params = await searchParams;
  const showMailPrefs = session.kind === "staff" && (session.role === "admin" || session.role === "manager");
  const [sessions, factor, mailPrefs] = await Promise.all([
    listSessions(session.userId),
    mfaStatus(session.userId),
    showMailPrefs ? memberEmailPrefs(session.orgId, session.userId) : Promise.resolve(null),
  ]);
  const jar = await cookies();
  const challenge = params.enroll === "1" ? await peekChallenge(jar.get(CHALLENGE_COOKIE)?.value ?? "") : null;
  const backup = params.backup === "1" ? backupDisplay(jar.get(BACKUP_COOKIE)?.value) : null;
  return (
    <>
      <PageHeader title={t("i_account")} />
      <ErrorBanner t={t} error={params.error} />
      {params.saved === "1" ? <div className="alert ok">{t("i_saved")}</div> : null}
      <div className="grid2">
        <div className="card pad">
          <h3>{t("i_profile")}</h3>
          <p>
            <b>{session.name}</b>
          </p>
          <p className="small">{session.email}</p>
          {showDemoLineCopy(session.environment) ? (
            <div data-demo-line="true">
              <p className="small muted" data-testid="line-demo-note">
                {t("i_line_demo")}
              </p>
              {lineLoginEnabled() ? (
                <button className="btn" type="button" data-testid="line-link">
                  LINE
                </button>
              ) : null}
            </div>
          ) : null}
        </div>
        <form className="card pad" action={actionChangePassword}>
          <h3>{t("i_change_password")}</h3>
          <div className="fg">
            <label className="f">{t("i_current_password")}</label>
            <input className="inp" name="current" type="password" autoComplete="current-password" />
          </div>
          <PasswordFields />
          <button className="btn pri" type="submit">
            {t("i_save_password")}
          </button>
        </form>
        <div className="card pad">
          <h3>{t("i_mfa")}</h3>
          <p>{factor.enabled ? t("i_mfa_on") : t("i_mfa_off")}</p>
          {backup?.clearCookie ? <BackupCodes codes={backup.codes} note={t("i_backup_once")} /> : null}
          {challenge?.secret ? (
            <form action={actionConfirmMfa}>
              <div className="alert info">
                <div>{challenge.otpauth}</div>
                <code>{challenge.secret}</code>
              </div>
              <div className="fg">
                <label className="f">{t("i_mfa_code")}</label>
                <input className="inp" name="code" data-testid="account-mfa-code" inputMode="numeric" />
              </div>
              <button className="btn pri" type="submit">
                {t("i_continue")}
              </button>
            </form>
          ) : factor.enabled && factor.required ? (
            <p data-testid="mfa-locked">{t("i_mfa_locked")}</p>
          ) : (
            <div className="row">
              <form action={actionBeginMfa}>
                <button className="btn" type="submit" data-testid="mfa-start">
                  {factor.enabled ? t("i_mfa_reset") : t("i_mfa_setup")}
                </button>
              </form>
              {factor.enabled ? (
                <form action={actionDisableMfa}>
                  <button className="btn" type="submit">
                    {t("i_mfa_off_btn")}
                  </button>
                </form>
              ) : null}
            </div>
          )}
          {can(session.role, "settings.edit") ? (
            <form action={actionRequireMfa} style={{ marginTop: 12 }}>
              <label className="row">
                <input type="checkbox" name="require" defaultChecked={factor.required} /> {t("i_require_mfa")}
              </label>
              <button className="btn sm" type="submit" data-testid="require-mfa">
                {t("i_save")}
              </button>
            </form>
          ) : null}
        </div>
        {mailPrefs ? (
          <form className="card pad" action={actionEmailPrefs}>
            <h3>{t("i_mail_heading")}</h3>
            <label className="row">
              <input type="checkbox" name="leaseExpiry" defaultChecked={mailPrefs.leaseExpiry} data-testid="mail-lease" />
              {t("i_mail_lease")}
            </label>
            <label className="row">
              <input type="checkbox" name="rentOverdue" defaultChecked={mailPrefs.rentOverdue} data-testid="mail-overdue" />
              {t("i_mail_overdue")}
            </label>
            <p className="small muted">{t("i_mail_off_hint")}</p>
            <button className="btn sm" type="submit">
              {t("i_save")}
            </button>
          </form>
        ) : null}
        <div className="card pad">
          <h3>{t("i_devices")}</h3>
          <form action={actionRevokeOthers}>
            <button className="btn sm" type="submit" data-testid="sign-out-others">
              {t("i_sign_out_others")}
            </button>
          </form>
          <ul>
            {sessions.map((device) => (
              <li key={device.id} style={{ marginTop: 8 }}>
                <div className="small">{device.user_agent || t("i_unknown_device")}</div>
                <div className="tiny muted">{device.ip || t("i_unknown_place")}</div>
                {device.id === session.sessionId ? <span className="chip pri">{t("i_this_device")}</span> : null}
                <form action={actionRevokeSession}>
                  <input type="hidden" name="sessionId" value={device.id} />
                  <button className="btn sm" type="submit">
                    {t("i_sign_out")}
                  </button>
                </form>
              </li>
            ))}
          </ul>
        </div>
      </div>
    </>
  );
}
