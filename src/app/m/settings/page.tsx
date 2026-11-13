// FILE: src/app/m/settings/page.tsx
import { upgradeGate } from "@/server/upgrade-gate";
import { FREE_UNITS } from "@/server/billing";
import { guardEffectiveSession } from "@/server/b017-custom-role-governance";
import { requireCurrentConsent } from "@/server/consent-gate";
import { makeT } from "@/i18n";
import { ErrorBanner, PageHeader } from "@/components/ui";
import { actionOrgMail } from "@/server/auth-actions";
import { orgMailSettings } from "@/server/mail-settings";
import { can } from "@/server/perms";
import { isPlatformAdmin } from "@/server/platform";
import { getSession } from "@/server/session";
import { PartnerConsentHistory } from "@/components/partner-consent-history";
import { PayeeSettings } from "@/components/payee-settings";
import { isPricingInterimEnabled } from "@/server/pricing-interim";
import { UsageCard } from "@/components/usage-card";
import { commercialTier } from "@/server/seats";
import { countActiveUnits } from "@/server/sandbox";
import { trialCardState } from "@/server/b056-trial";
import { formatTrialDate, parseTrialPlan, previewTrialEnd } from "@/server/b056-trial-rules";
import { TrialConfirm } from "@/components/b056-trial-confirm";

export const dynamic = "force-dynamic";

export default async function SettingsPage({ searchParams }: { searchParams: Promise<{ error?: string; saved?: string; trial?: string }> }) {
  await requireCurrentConsent(undefined, "page");
  const query = await searchParams;
  const session = await guardEffectiveSession(await getSession(), "settings.edit");
  const gate = await upgradeGate(session, FREE_UNITS);
  const t = makeT(session.locale);
  const mail = can(session, "settings.edit") ? await orgMailSettings(session.orgId) : null;
  const interimOn = session.environment === "live" && (await isPricingInterimEnabled(session.liveOrgId));
  const trial = await trialCardState(session);
  const tier = trial ? trial.plan.tier : interimOn ? await commercialTier(session.liveOrgId) : null;
  const confirmPlan = trial?.offer === "admin" ? parseTrialPlan(query.trial) : null;
  return (
    <>
      <PageHeader title={t("i_nav_settings")} />
      <PartnerConsentHistory session={session} />
      <PayeeSettings session={session} />
      <ErrorBanner t={t} error={query.error} />
      {query.saved === "1" ? <div className="alert ok">{t("i_saved")}</div> : null}
      {mail ? (
        <form className="card pad" action={actionOrgMail} style={{ maxWidth: 720, marginBottom: 16 }}>
          <h3>{t("i_mail_org")}</h3>
          <label className="row">
            <input type="checkbox" name="tenantLease" defaultChecked={mail.tenantLease} data-testid="tenant-lease-mail" />
            {t("i_mail_tenant_lease")}
          </label>
          <label className="row">
            <input type="checkbox" name="tenantOverdue" defaultChecked={mail.tenantOverdue} data-testid="tenant-overdue-mail" />
            {t("i_mail_tenant_overdue")}
          </label>
          <div className="fg">
            <label className="f">{t("i_mail_contact_email")}</label>
            <input className="inp" name="contactEmail" type="email" defaultValue={mail.contactEmail} data-testid="org-contact-email" />
            <p className="small muted">{t("i_mail_contact_hint")}</p>
          </div>
          <div className="fg">
            <label className="f">{t("i_mail_contact_phone")}</label>
            <input className="inp" name="contactPhone" defaultValue={mail.contactPhone} />
          </div>
          <button className="btn pri" type="submit">
            {t("i_save")}
          </button>
        </form>
      ) : null}
      <div className="card pad" style={{ maxWidth: 720 }}>
        {!gate.redirectTo && session.environment === "sandbox" ? (
          <div className="alert warn" data-testid="sandbox-plan" style={{ marginBottom: 12 }}>
            {t("i_sandbox_plan")}
          </div>
        ) : null}
        {interimOn || trial ? (
          <UsageCard
            locale={session.locale}
            plan={tier === "standard" || tier === "pro" || tier === "free" ? tier : "free"}
            units={await countActiveUnits(session.liveOrgId)}
            trial={trial?.plan.kind === "trial" && trial.plan.trial ? {
              plan: trial.plan.trial.plan,
              endsOn: formatTrialDate(trial.plan.trial.endsAt),
              daysLeft: trial.daysLeft!,
            } : null}
            offer={trial?.offer}
          />
        ) : gate.redirectTo || session.environment === "sandbox" ? null : (
          <p data-testid="settings-plan">{t("i_settings_plan")}</p>
        )}
        {isPlatformAdmin(session.email) ? (
          <p>
            <a href="/m/admin">{t("i_admin_title")}</a>
          </p>
        ) : null}
        <p>{t("i_rules_note")}</p>
        <p className="small">{t("s_c6a6031")}</p>
        <p className="small muted">{t("s_ff6ff46")}</p>
      </div>
      {session.role === "admin" ? (
        <div className="card pad" style={{ maxWidth: 720, marginTop: 16 }}>
          <h3>{t("idv_ret_h")}</h3>
          <p id="idvRetainDays" data-testid="idv-retain-days">
            {t("i_id_retain")}
          </p>
        </div>
      ) : null}
      {confirmPlan ? <TrialConfirm locale={session.locale} plan={confirmPlan} endsOn={formatTrialDate(previewTrialEnd(confirmPlan, new Date()))} /> : null}
    </>
  );
}
