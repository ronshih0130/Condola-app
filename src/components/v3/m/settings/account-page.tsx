import React, { Suspense } from "react";
import { cookies } from "next/headers";
import { ErrorBanner, PageHeader } from "../../../ui";
import { PendingSubmit } from "../../../pending-submit";
import { BackupCodes } from "../../../backup-codes";
import { PasswordFields } from "../../../password-field";
import { makeT } from "../../../../i18n";
import { brandV3AcctCopy } from "../../../../i18n/lanes/brand-v3-r5-acct";
import { staffProfileCopy } from "../../../../i18n/staff-profile";
import { accountRead } from "../../../../server/b073-account";
import {
  actionBeginMfa,
  actionChangePassword,
  actionConfirmMfa,
  actionDisableMfa,
  actionRevokeOthers,
  actionRevokeSession,
} from "../../../../server/auth-actions";
import { actionSaveStaffDisplayName } from "../../../../server/staff-profile-actions";
import { CHALLENGE_COOKIE } from "../../../../server/auth";
import { BACKUP_COOKIE, backupDisplay } from "../../../../server/backup";
import { hasPersonalReminders } from "../../../../server/perms";
import type { Session } from "../../../../server/types";
import { ACCOUNT_CSS_HREF, AccountError, AccountLayout, AccountLoading } from "./account";

/** The query today's account actions send back (`/m/account?…`); read the same way as today. */
export type AccountParams = { error?: string; saved?: string; enroll?: string; backup?: string; profile?: string };
const PROFILE_RESULTS = ["stale", "invalid", "unavailable"] as const;

/**
 * R5-ACCT body (brand_v3 only; the page renders AccountLoading while this reads). Every form below is today's form
 * posting to today's server action, unchanged; only the buttons are outline (no solid primary on this page).
 * Not here under v3: 「要求全體成員啟用兩步驟驗證」 (團隊) and the reminder switches (通知設定).
 */
export async function AccountSection({ session, params }: { session: Session; params: AccountParams }) {
  const jar = await cookies();
  const read = await accountRead(session, params.enroll === "1" ? { challengeId: jar.get(CHALLENGE_COOKIE)?.value ?? "" } : {});
  if (read.state !== "ready") return <AccountError locale={session.locale} />;
  const t = makeT(session.locale);
  const profileCopy = staffProfileCopy(session.locale);
  const profileMessage = params.profile && (PROFILE_RESULTS as readonly string[]).includes(params.profile) ? profileCopy[params.profile as typeof PROFILE_RESULTS[number]] : null;
  const backup = params.backup === "1" ? backupDisplay(jar.get(BACKUP_COOKIE)?.value) : null;
  const challenge = read.challenge;
  const staff = session.kind === "staff";
  const basicsNote = staff || profileMessage ? <div className="v3-acct-note">
    {staff ? <p>{profileCopy.scope}</p> : null}
    {profileMessage ? <p role="status">{profileMessage}</p> : null}
    {staff && session.environment === "sandbox" ? <p>{profileCopy.sandbox} <a href="/api/env?set=live&next=%2Fm%2Faccount">{profileCopy.live}</a></p> : null}
  </div> : null;
  const nameEdit = read.profile.state === "ready" ? <form action={actionSaveStaffDisplayName}>
    <label className="f" htmlFor="staff-display-name">{profileCopy.label}</label>
    <input id="staff-display-name" className="inp" name="name" defaultValue={read.profile.name} maxLength={100} required />
    <input type="hidden" name="version" value={read.profile.version} />
    <PendingSubmit className="btn sm" idle={profileCopy.save} pending={profileCopy.working} />
  </form> : null;
  const password = <form action={actionChangePassword}>
    <div className="fg">
      <label className="f">{t("i_current_password")}</label>
      <input className="inp" name="current" type="password" autoComplete="current-password" />
    </div>
    <PasswordFields />
    <button className="btn" type="submit">{t("i_save_password")}</button>
  </form>;
  const mfa = <>
    {backup?.clearCookie ? <BackupCodes codes={backup.codes} note={t("i_backup_once")} /> : null}
    {challenge?.secret ? <form action={actionConfirmMfa}>
      <div className="alert info">
        <div>{challenge.otpauth}</div>
        <code>{challenge.secret}</code>
      </div>
      <div className="fg">
        <label className="f">{t("i_mfa_code")}</label>
        <input className="inp" name="code" data-testid="account-mfa-code" inputMode="numeric" />
      </div>
      <button className="btn" type="submit">{t("i_continue")}</button>
    </form> : read.mfa.enabled && read.mfa.required ? <p data-testid="mfa-locked">{t("i_mfa_locked")}</p> : <div className="row">
      <form action={actionBeginMfa}>
        <button className="btn" type="submit" data-testid="mfa-start">{read.mfa.enabled ? t("i_mfa_reset") : t("i_mfa_setup")}</button>
      </form>
      {read.mfa.enabled ? <form action={actionDisableMfa}>
        <button className="btn" type="submit">{t("i_mfa_off_btn")}</button>
      </form> : null}
    </div>}
  </>;
  const devices = <>
    <form action={actionRevokeOthers}>
      <button className="btn sm" type="submit" data-testid="sign-out-others">{t("i_sign_out_others")}</button>
    </form>
    <ul className="v3-acct-devices">
      {read.devices.map(device => <li key={device.id}>
        <div className="small">{device.userAgent || t("i_unknown_device")}</div>
        <div className="tiny muted">{device.ip || t("i_unknown_place")}</div>
        {device.id === session.sessionId ? <span className="chip">{t("i_this_device")}</span> : null}
        <form action={actionRevokeSession}>
          <input type="hidden" name="sessionId" value={device.id} />
          <button className="btn sm" type="submit">{t("i_sign_out")}</button>
        </form>
      </li>)}
    </ul>
  </>;
  return <AccountLayout locale={session.locale} t={t} name={session.name} email={session.email}
    phone={read.phone} line={read.line} mfaOn={read.mfa.enabled} deviceCount={read.devices.length}
    nameEdit={nameEdit} nameEditOpen={profileMessage !== null} basicsNote={basicsNote}
    password={password} mfa={mfa} mfaOpen={params.enroll === "1" || params.backup === "1"} devices={devices}
    footer={hasPersonalReminders(session)} />;
}

/** /m/account under brand_v3: its own stylesheet, the approved lead, today's result lines, then the cards. */
export function AccountV3Page({ session, params }: { session: Session; params: AccountParams }) {
  const t = makeT(session.locale);
  return <>
    <link rel="stylesheet" href={ACCOUNT_CSS_HREF} />
    <PageHeader title={brandV3AcctCopy(session.locale).lead} />
    <ErrorBanner t={t} error={params.error} />
    {params.saved === "1" ? <div className="alert ok">{t("i_saved")}</div> : null}
    <Suspense fallback={<AccountLoading locale={session.locale} />}><AccountSection session={session} params={params} /></Suspense>
  </>;
}
