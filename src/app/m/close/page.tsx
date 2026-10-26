import { requireCurrentConsent } from "@/server/consent-gate";
import { makeT } from "@/i18n";
import { ErrorBanner, PageHeader } from "@/components/ui";
import { actionCloseMonth } from "@/server/auth-actions";
import { taipeiToday } from "@/server/money";
import { getSession } from "@/server/session";
import { maybe, tx } from "@/server/db";

export const dynamic = "force-dynamic";

export default async function ClosePage({ searchParams }: { searchParams: Promise<{ error?: string; saved?: string }> }) {
  await requireCurrentConsent(undefined, "page");
  const session = await getSession();
  const t = makeT(session.locale);
  const params = await searchParams;
  const month = taipeiToday().slice(0, 7);
  const closed = await tx(session.userId, async (client) =>
    maybe<{ period_month: string }>(
      client,
      `SELECT max(period_month)::text AS period_month FROM month_closes WHERE org_id = $1`,
      [session.orgId],
    ),
  );
  return (
    <>
      <PageHeader title={t("i_nav_close")} />
      <ErrorBanner t={t} error={params.error} />
      {params.saved === "1" ? <div className="alert ok">{t("i_month_closed")}</div> : null}
      <form className="card pad" action={actionCloseMonth} style={{ maxWidth: 560 }}>
        <p className="small">{t("i_close_hint")}</p>
        {closed?.period_month ? <p className="small muted">{t("i_last_close", { month: closed.period_month.slice(0, 7) })}</p> : null}
        <div className="fg">
          <label className="f">{t("i_month")}</label>
          <input className="inp" type="month" name="month" defaultValue={month} data-testid="close-month" />
        </div>
        <div className="fg">
          <label className="f">{t("i_note")}</label>
          <input className="inp" name="note" />
        </div>
        <button className="btn pri" type="submit" data-testid="close-month-submit">
          {t("i_close_month")}
        </button>
      </form>
    </>
  );
}
