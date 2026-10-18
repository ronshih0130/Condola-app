import { makeT } from "@/i18n";
import { PageHeader } from "@/components/ui";
import { getSession } from "@/server/session";

export const dynamic = "force-dynamic";

export default async function SettingsPage() {
  const session = await getSession();
  const t = makeT(session.locale);
  return (
    <>
      <PageHeader title={t("i_nav_settings")} />
      <div className="card pad" style={{ maxWidth: 720 }}>
        <p>{t("i_rules_note")}</p>
        <p className="small">{t("s_c6a6031")}</p>
        <p className="small muted">{t("s_ff6ff46")}</p>
      </div>
    </>
  );
}
