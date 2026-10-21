import { makeT } from "@/i18n";
import { ApproveForm, BankImport } from "@/components/dialogs";
import { ErrorBanner, PageHeader } from "@/components/ui";
import { sampleCsv } from "@/server/domain";
import { formatMoney } from "@/server/format";
import { latestUnmatchedPayment, listMatches } from "@/server/queries";
import { displaySampleName } from "@/server/sandbox-data";
import { getSession } from "@/server/session";

export const dynamic = "force-dynamic";

export default async function BankPage({ searchParams }: { searchParams: Promise<{ error?: string }> }) {
  const session = await getSession();
  const t = makeT(session.locale);
  const params = await searchParams;
  const [payment, matches] = await Promise.all([latestUnmatchedPayment(session), listMatches(session)]);
  const sample = payment
    ? sampleCsv({
        paidOn: payment.paid_on,
        amountMinor: Number(payment.amount_minor),
        last5: payment.last5 ?? "00000",
        currency: payment.currency,
      })
    : "";
  return (
    <>
      <PageHeader title={t("i_nav_bank")} crumb={t("s_01cca89")} />
      <ErrorBanner t={t} error={params.error} />
      <div className="grid2">
        <BankImport sample={sample} />
        <div className="card">
          <div className="hd">
            <h3>{t("i_match")}</h3>
          </div>
          {matches.length === 0 ? (
            <div className="empty">{t("i_bank_empty")}</div>
          ) : (
            <table className="t rf">
              <tbody>
                {matches.map((match) => (
                  <tr key={match.id}>
                    <td>
                      {displaySampleName(match.tenant)}
                      <div className="small muted">
                        {match.posted_on} · {match.last5} · {t("i_score", { score: match.score })}
                      </div>
                    </td>
                    <td className="num" data-label={t("i_amount_label")}>
                      {formatMoney(Number(match.amount), match.currency, session.locale)}
                    </td>
                    <td className="r">
                      <ApproveForm id={match.id} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>
    </>
  );
}
