import { requireCurrentConsent } from "@/server/consent-gate";
import { makeT } from "@/i18n";
import { PageHeader } from "@/components/ui";
import { getSession } from "@/server/session";
import { brandV3EnabledForOrg } from "@/server/brand-v3";
import { NotifyV3Page } from "@/components/v3/m/settings/notify-page";

export const dynamic = "force-dynamic";

export default async function NotifyPage() {
  await requireCurrentConsent(undefined, "page");
  const session = await getSession();
  // R5-NOTIFY (MGT-135): under brand_v3 this is 設定 › 通知設定 (寄給我的 + admin-only 寄給租客的). The layout admits
  // admin and manager here under brand_v3 only. Flag OFF renders exactly as before.
  if (await brandV3EnabledForOrg(session.orgId)) return <NotifyV3Page session={session} />;
  const t = makeT(session.locale);
  return (
    <>
      <PageHeader title={t("i_nav_notify")} />
      <p className="muted" data-testid="notify-empty">
        {t("i_notify_empty")}
      </p>
    </>
  );
}
