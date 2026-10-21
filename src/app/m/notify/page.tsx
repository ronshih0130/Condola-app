import { makeT } from "@/i18n";
import { PageHeader } from "@/components/ui";
import { showDemoLineCopy } from "@/server/demo";
import { getSession } from "@/server/session";

export const dynamic = "force-dynamic";

export default async function NotifyPage() {
  const session = await getSession();
  const t = makeT(session.locale);
  const demoLine = showDemoLineCopy(session.environment);
  return (
    <>
      <PageHeader title={t("i_nav_notify")} />
      {demoLine ? (
        <>
          <div className="alert info" data-testid="line-stub">
            {t("i_line_stub")}
          </div>
          <p data-testid="notify-note">{t("i_notify_note")}</p>
        </>
      ) : (
        <p className="muted" data-testid="notify-empty">
          {t("i_notify_empty")}
        </p>
      )}
    </>
  );
}
