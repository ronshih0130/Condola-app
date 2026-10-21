import { makeT } from "@/i18n";
import { PageHeader } from "@/components/ui";
import { getSession } from "@/server/session";

export const dynamic = "force-dynamic";

export default async function NotifyPage() {
  const session = await getSession();
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
