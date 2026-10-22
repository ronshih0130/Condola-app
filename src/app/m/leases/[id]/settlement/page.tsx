import Link from "next/link";
import { notFound } from "next/navigation";
import { PdfDownloadButton } from "@/components/pdf-download-button";
import { ErrorBanner, PageHeader } from "@/components/ui";
import { makeT } from "@/i18n";
import { actionAddDeduction, actionConfirmSettlement, actionRemoveDeduction } from "@/server/actions";
import { moneyLabel } from "@/server/format";
import { lifecycleEnabledFor, settlementContext } from "@/server/lease-lifecycle";
import {
  COPY,
  majorOf,
  moveOutDone,
  nt,
  overrideNote,
  overrideStamp,
  periodRentLabel,
  refundDateLabel,
  rentFormula,
  settlementTitle,
  shortfallBody,
} from "@/server/lease-lifecycle-rules";
import { taipeiToday } from "@/server/money";
import { displaySampleName } from "@/server/sandbox-data";
import { getSession } from "@/server/session";

export const dynamic = "force-dynamic";

export default async function SettlementPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ error?: string; done?: string }>;
}) {
  const { id } = await params;
  const query = await searchParams;
  const session = await getSession();
  if (session.kind !== "staff" || !(await lifecycleEnabledFor(session))) notFound();
  const view = await settlementContext(session, id);
  if (!view) notFound();
  const tenant = displaySampleName(view.tenant);
  const t = makeT(session.locale);
  const money = (minor: number) => (view.currency === "TWD" ? nt(majorOf(minor, view.currency)) : moneyLabel(minor, view.currency, session.locale));
  const monthlyMajor = majorOf(view.monthlyMinor, view.currency);
  const defaultMajor = majorOf(view.defaultMinor, view.currency);
  const finalMajor = majorOf(view.finalRentMinor, view.currency);
  const shortfall = view.shortfallMinor > 0;
  const done = view.status === "confirmed";
  const canWrite = session.role === "admin" || session.role === "manager";
  return (
    <>
      <PageHeader
        title={done ? COPY.doneTitle : settlementTitle(tenant)}
        crumb={<Link href="/m/leases/expiring">{COPY.listTitle}</Link>}
      />
      <ErrorBanner t={t} error={query.error} />
      {done ? (
        <div data-testid="moveout-done">
          <p>{moveOutDone(tenant, view.moveOutOn)}</p>
          <div className="card">
            <table className="t">
              <tbody>
                <tr>
                  <td>{periodRentLabel(view.moveOutOn)}</td>
                  <td data-testid="done-rent">{money(view.finalRentMinor)}</td>
                </tr>
                <tr>
                  <td>{COPY.ownerRefundDone}</td>
                  <td data-testid="done-refund">{money(view.refundMinor)}</td>
                </tr>
                <tr>
                  <td>{COPY.refundDate}</td>
                  <td data-testid="done-refund-date">{view.refundOn ? refundDateLabel(view.refundOn) : ""}</td>
                </tr>
                <tr>
                  <td>{COPY.vacantPower}</td>
                  <td>{COPY.vacantPowerNote}</td>
                </tr>
              </tbody>
            </table>
          </div>
          {view.shortfallMinor > 0 ? (
            <div className="alert bad" data-testid="shortfall">
              <b>{COPY.shortfallTitle}</b>
              <p>{shortfallBody(majorOf(view.shortfallMinor, view.currency))}</p>
            </div>
          ) : null}
          <p>
            <PdfDownloadButton
              href={`/api/pdf/settlements/${id}`}
              label={COPY.download}
              failed={t("pdf_failed")}
              fontFailed={t("pdf_font_missing")}
              testId="download-settlement-pdf"
            />
          </p>
          <p className="small" data-testid="money-disclaimer">{COPY.disclaimer}</p>
        </div>
      ) : (
        <div data-testid="settlement-draft">
          <p data-testid="rent-formula">{rentFormula(monthlyMajor, view.days, defaultMajor)}</p>
          {view.overridden ? <p data-testid="override-note">{overrideNote(defaultMajor, finalMajor)}</p> : null}
          {view.overridden && view.actor && view.overriddenAt ? (
            <p data-testid="override-stamp">{overrideStamp(view.actor, new Date(view.overriddenAt))}</p>
          ) : null}
          {shortfall ? (
            <div className="alert bad" data-testid="shortfall">
              <b>{COPY.shortfallTitle}</b>
              <p data-testid="shortfall-body">{shortfallBody(majorOf(view.shortfallMinor, view.currency))}</p>
            </div>
          ) : null}
          <div className="card">
            <table className="t">
              <tbody>
                <tr>
                  <td>{COPY.depositSection}</td>
                  <td />
                </tr>
                <tr>
                  <td>{COPY.depositHeld}</td>
                  <td data-testid="settlement-deposit">{money(view.depositMinor)}</td>
                </tr>
                <tr>
                  <td>{COPY.deductions}</td>
                  <td />
                </tr>
                {view.lines.map((line) => (
                  <tr key={line.id} data-testid="settlement-line">
                    <td>{line.label}</td>
                    <td>
                      {money(line.amountMinor)}
                      {canWrite && line.kind !== "unpaid_rent" ? (
                        <form action={actionRemoveDeduction} style={{ display: "inline", marginLeft: 8 }}>
                          <input type="hidden" name="leaseId" value={id} />
                          <input type="hidden" name="lineId" value={line.id} />
                          <button className="btn" type="submit" data-testid="remove-deduction">{COPY.cancel}</button>
                        </form>
                      ) : null}
                    </td>
                  </tr>
                ))}
                <tr>
                  <td>{COPY.deductionTotal}</td>
                  <td data-testid="deduction-total">{money(view.deductionsMinor)}</td>
                </tr>
                {shortfall ? (
                  <tr>
                    <td>{COPY.shortfallRow}</td>
                    <td data-testid="shortfall-amount">{money(view.shortfallMinor)}</td>
                  </tr>
                ) : (
                  <tr>
                    <td>{COPY.ownerRefund}</td>
                    <td data-testid="refund-amount">{money(view.refundMinor)}</td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
          <p className="small" data-testid="money-disclaimer">{COPY.disclaimer}</p>
          {canWrite ? (
            <>
              <form action={actionAddDeduction} className="card pad" id="deductions" data-testid="add-deduction" style={{ marginTop: 16 }}>
                <h3>{COPY.addDeduction}</h3>
                <input type="hidden" name="leaseId" value={id} />
                <div className="grid2">
                  <div className="fg">
                    <label className="f">{COPY.deductions}</label>
                    <select className="inp" name="kind" data-testid="deduction-kind">
                      <option value="repair">修繕</option>
                      <option value="electricity">{COPY.electricity}</option>
                    </select>
                  </div>
                  <div className="fg">
                    <label className="f">金額</label>
                    <input className="inp" name="amount" inputMode="numeric" data-testid="deduction-amount" required />
                  </div>
                </div>
                <div className="fg">
                  <label className="f">項目</label>
                  <input className="inp" name="item" data-testid="deduction-item" />
                </div>
                <div className="fg">
                  <label className="f">照片</label>
                  <input className="inp" type="file" name="photos" accept="image/*" multiple data-testid="deduction-photos" />
                </div>
                <button className="btn" type="submit" data-testid="add-deduction-submit">{COPY.addDeduction}</button>
              </form>
              <form action={actionConfirmSettlement} className="row" style={{ marginTop: 16 }}>
                <input type="hidden" name="leaseId" value={id} />
                <div className="fg">
                  <label className="f">{COPY.refundDate}</label>
                  <input className="inp" type="date" name="refundOn" data-testid="refund-on" defaultValue={taipeiToday()} required />
                </div>
                {shortfall ? <a className="btn" href="#deductions" data-testid="shortfall-back">{COPY.back}</a> : null}
                <button className="btn pri" type="submit" data-testid="confirm-settlement">{COPY.confirmSettle}</button>
              </form>
            </>
          ) : null}
        </div>
      )}
    </>
  );
}
