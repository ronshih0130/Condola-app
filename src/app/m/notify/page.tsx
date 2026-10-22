import { makeT } from "@/i18n";
import { LineNotify } from "@/components/line-notify";
import { PageHeader } from "@/components/ui";
import { loadStaffLinePanel } from "@/server/line-store";
import { getSession } from "@/server/session";

export const dynamic = "force-dynamic";

export default async function NotifyPage({
  searchParams,
}: {
  searchParams: Promise<{ link?: string; saved?: string; unlinked?: string; limit?: string }>;
}) {
  const session = await getSession();
  const t = makeT(session.locale);
  const params = await searchParams;
  const panel = await loadStaffLinePanel(session);
  if (!panel.showLine) {
    return (
      <>
        <PageHeader title={t("i_nav_notify")} />
        <p className="muted" data-testid="notify-empty">
          {t("i_notify_empty")}
        </p>
      </>
    );
  }
  return (
    <>
      <PageHeader title={t("i_nav_notify")} />
      <LineNotify
        showLine={panel.showLine}
        lineLive={panel.lineLive}
        status={panel.status}
        linkedOn={panel.linkedOn}
        code={panel.code}
        qrSvg={panel.qrSvg}
        deepLink={panel.deepLink}
        prefs={panel.prefs}
        openLink={params.link === "1"}
        saved={params.saved === "1"}
        unlinked={params.unlinked === "1"}
        limit={params.limit === "1"}
      />
    </>
  );
}
