import { makeT } from "@/i18n";
import { ErrorBanner, PageHeader } from "@/components/ui";
import { actionOrgMail } from "@/server/auth-actions";
import { orgMailSettings } from "@/server/mail-settings";
import { can } from "@/server/perms";
import { isPlatformAdmin } from "@/server/platform";
import { getSession } from "@/server/session";

export const dynamic = "force-dynamic";

export default async function SettingsPage({ searchParams }: { searchParams: Promise<{ error?: string; saved?: string }> }) {
  const session = await getSession();
  const query = await searchParams;
  const t = makeT(session.locale);
  const mail = can(session.role, "settings.edit") ? await orgMailSettings(session.orgId) : null;
  return (
    <>
      <PageHeader title={t("i_nav_settings")} />
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
        {session.environment === "sandbox" ? (
          <div className="alert warn" data-testid="sandbox-plan" style={{ marginBottom: 12 }}>
            {t("i_sandbox_plan")}
          </div>
        ) : null}
        {session.environment === "sandbox" ? null : (
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
    </>
  );
}
