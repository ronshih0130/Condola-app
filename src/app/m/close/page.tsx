import { requireCurrentConsent } from "@/server/consent-gate";
import { makeT } from "@/i18n";
import { ErrorBanner, PageHeader } from "@/components/ui";
import { actionCloseMonth } from "@/server/auth-actions";
import { taipeiToday } from "@/server/money";
import { getSession } from "@/server/session";
import { maybe, tx } from "@/server/db";
import { utilityReconciliation } from "@/server/utility-reconciliation";
import { billingPreviewCopy } from "@/i18n/billing-preview";
import { statementSignedMoney } from "@/server/format";

export const dynamic = "force-dynamic";

export default async function ClosePage({ searchParams }: { searchParams: Promise<{ error?: string; saved?: string; month?: string }> }) {
  await requireCurrentConsent(undefined, "page");
  const session = await getSession();
  const t = makeT(session.locale);
  const params = await searchParams;
  const month = params.month && /^\d{4}-(0[1-9]|1[0-2])$/.test(params.month) ? params.month : taipeiToday().slice(0, 7);
  const utility = await utilityReconciliation(session, month);
  const copy = billingPreviewCopy(session.locale);
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
      {utility ? <section className="card pad" data-testid="utility-reconciliation">
        <h2>{copy.utility}</h2><form method="get"><label>{copy.period} <input type="month" name="month" defaultValue={month} /></label> <button className="btn" type="submit">{copy.select}</button></form>
        <p className="small">{copy.billCaveat}</p>
        {utility.length === 0 ? <p>{copy.empty}</p> : <ul>{utility.map((row) => <li key={row.id}><strong>{row.property} · {row.unit}</strong> ({row.start} – {row.end}, {row.status}) {row.reconciliation ? <dl>{([[copy.storedBill,row.reconciliation.bill],[copy.tenant,row.reconciliation.tenant],[copy.owner,row.reconciliation.owner],[copy.publicPower,row.reconciliation.publicAmount],[copy.gap,row.reconciliation.gap],[copy.remainder,row.reconciliation.remainder],[copy.discrepancy,row.reconciliation.difference]] as const).map(([label,value]) => <div key={label}><dt>{label}</dt><dd>{statementSignedMoney(value,row.currency,session.locale)}</dd></div>)}</dl> : <p role="alert">{copy.unknown}</p>}</li>)}</ul>}
      </section> : null}
      <form className="card pad" action={actionCloseMonth} style={{ maxWidth: 560 }}>
        <p className="small">{t("i_close_hint")}</p>
        {closed?.period_month ? <p className="small muted">{t("i_last_close", { month: closed.period_month.slice(0, 7) })}</p> : null}
        <div className="fg">
          <label className="f">{t("i_month")}</label>
          {utility ? <><input className="inp" type="month" value={month} readOnly data-testid="close-month" /><input type="hidden" name="month" value={month} /></> : <input className="inp" type="month" name="month" defaultValue={month} data-testid="close-month" />}
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
