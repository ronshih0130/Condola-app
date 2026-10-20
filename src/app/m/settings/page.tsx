import { makeT } from "@/i18n";
import { PageHeader } from "@/components/ui";
import { isPlatformAdmin } from "@/server/platform";
import { getSession } from "@/server/session";

export const dynamic = "force-dynamic";

export default async function SettingsPage({ searchParams }: { searchParams: Promise<{ upgrade?: string }> }) {
  const session = await getSession();
  const query = await searchParams;
  const t = makeT(session.locale);
  return (
    <>
      <PageHeader title={t("i_nav_settings")} />
      <div className="card pad" style={{ maxWidth: 720 }}>
        {session.environment === "sandbox" ? (
          <div className="alert warn" data-testid="sandbox-plan" style={{ marginBottom: 12 }}>
            {t("i_sandbox_plan")}
          </div>
        ) : null}
        {query.upgrade === "1" ? <p data-testid="upgrade-hint">{t("i_golive_upgrade_hint")}</p> : null}
        <p>
          <a href="/pricing">{t("i_nav_pricing")}</a>
          {" · "}
          <a href="/m/upgrade">{t("i_price_upgrade")}</a>
        </p>
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
