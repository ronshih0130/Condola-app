import Link from "next/link";
import { notFound } from "next/navigation";
import { makeT } from "@/i18n";
import { PdfDownloadButton } from "@/components/pdf-download-button";
import { StatementDocument } from "@/components/statement-document";
import { PageHeader } from "@/components/ui";
import { actionRecordPayout, actionStatement } from "@/server/actions";
import { moneyLabel, signedMoneyLabel } from "@/server/format";
import { can } from "@/server/perms";
import { statementDetail } from "@/server/queries";
import { civilPeriodLabel } from "@/server/rent-settlement-math";
import { getSession } from "@/server/session";

export const dynamic = "force-dynamic";

export default async function StatementPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const session = await getSession();
  const t = makeT(session.locale);
  const detail = await statementDetail(session, id);
  if (!detail) notFound();
  const row = detail.statement;
  const period = civilPeriodLabel(row.period_start.slice(0, 7));
  const money = (minor: number) => moneyLabel(minor, row.currency, session.locale);
  const canRecord = can(session.role, "pay.record");
  const canGenerate = can(session.role, "stmt.generate");
  return (
    <>
      <PageHeader
        title={<span className="stmt-title">{t("i_stmt_doc_title", { owner: row.owner_name, period })}</span>}
        crumb={<Link href="/m/statements">{t("i_nav_stmt")}</Link>}
        actions={
          <>
            {canGenerate ? (
              <form action={actionStatement}>
                <input type="hidden" name="ownerContactId" value={row.owner_id} />
                <input type="hidden" name="month" value={row.period_start.slice(0, 7)} />
                <input type="hidden" name="regenerate" value="1" />
                <button className="btn" type="submit">{t("i_stmt_regen")}</button>
              </form>
            ) : null}
            <PdfDownloadButton
              href={`/api/pdf/statements/${id}`}
              label={t("s_874a842")}
              failed={t("pdf_failed")}
              fontFailed={t("pdf_font_missing")}
              testId="download-statement-pdf"
            />
          </>
        }
      />
      {row.changed ? (
        <p className="alert warn" data-testid="statement-changed">
          <span className="chip warn">{t("i_stmt_changed")}</span> {t("i_pay_stmt_changed_note")}
        </p>
      ) : null}
      <p className="small muted" data-testid="statement-version">{detail.history.length}</p>
      {detail.recipients.map((item) => (
        <p key={item.payee} data-testid="statement-recipient">
          {item.payee === "firm" ? t("i_stmt_payee_firm") : t("i_stmt_payee_owner")}
        </p>
      ))}
      <StatementDocument
        t={t}
        locale={session.locale}
        row={row}
        lines={detail.lines}
        note={<p className="small">{t("i_actor")}</p>}
      />
      {row.snapshot && row.changed ? (
        <div className="card pad" data-testid="statement-before" style={{ marginTop: 16, maxWidth: 640 }}>
          <h3>{t("i_stmt_before")}</h3>
          <p>
            {t("i_stmt_rent_sub")} {money(Number(row.snapshot.rent ?? 0))}
          </p>
          <p>
            {t("i_fee")} {signedMoneyLabel(-Number(row.snapshot.fee ?? 0), row.currency, session.locale)}
          </p>
          <p>
            {t("i_stmt_owner_net")} {signedMoneyLabel(Number(row.snapshot.rent ?? 0) - Number(row.snapshot.fee ?? 0) - Number(row.snapshot.expenses ?? 0), row.currency, session.locale)}
          </p>
          <p>
            {t("i_closing")} {signedMoneyLabel(Number(row.snapshot.closing ?? 0), row.currency, session.locale)}
          </p>
        </div>
      ) : null}
      {detail.history.length > 0 ? (
        <div className="card pad" data-testid="statement-history" style={{ marginTop: 16, maxWidth: 640 }}>
          <h3>{t("i_stmt_history")}</h3>
          <ul>
            {detail.history.map((item, index) => (
              <li key={`${item.at}-${index}`}>
                {item.summary || item.reason} <span className="small muted">{item.at?.slice(0, 16).replace("T", " ")}</span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      {canGenerate ? (
        <form action={actionRecordPayout} className="card pad" style={{ marginTop: 16, maxWidth: 640 }} data-testid="payout-form">
          <h3>{t("i_payouts")}</h3>
          <input type="hidden" name="statementId" value={id} />
          <input type="hidden" name="ownerContactId" value={row.owner_id} />
          <input type="hidden" name="month" value={row.period_start.slice(0, 7)} />
          <div className="fg">
            <label className="f">{t("i_pay_col_amount")}</label>
            <input className="inp" name="amount" inputMode="numeric" required data-testid="payout-amount" />
          </div>
          <div className="fg">
            <label className="f">{t("i_pay_note_opt")}</label>
            <input className="inp" name="note" />
          </div>
          <button className="btn" type="submit" disabled={!canRecord}>{t("i_pay_save")}</button>
        </form>
      ) : null}
    </>
  );
}
