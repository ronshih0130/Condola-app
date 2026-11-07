import { requireCurrentConsent } from "@/server/consent-gate";
import Link from "next/link";
import { redirect } from "next/navigation";
import { makeT } from "@/i18n";
import { PageHeader } from "@/components/ui";
import { PreviewGenerateForm } from "@/components/dialogs";
import { statementRoster } from "@/server/queries";
import { getSession } from "@/server/session";
import { can } from "@/server/perms";
import { statementSignedMoney } from "@/server/format";
import { billingPreviewCopy, billingPreviewExceptions } from "@/i18n/billing-preview";
import { statementPreview } from "@/server/statement-preview";

export const dynamic = "force-dynamic";

export default async function StatementPreviewPage({
  searchParams,
}: {
  searchParams: Promise<{ owner?: string; month?: string; changed?: string }>;
}) {
  await requireCurrentConsent(undefined, "page");
  const session = await getSession();
  const t = makeT(session.locale);
  const params = await searchParams;
  const month = params.month && /^\d{4}-\d{2}$/.test(params.month) ? params.month : "";
  const owner = params.owner ?? "";
  if (!month || !/^[0-9a-f-]{36}$/i.test(owner)) redirect("/m/statements");
  const roster = await statementRoster(session, month);
  const row = roster.find((item) => item.owner_id === owner && item.period_start.slice(0, 7) === month);
  if (!row) redirect("/m/statements");
  if (row.id) redirect(`/m/statements/${row.id}`);
  const preview = await statementPreview(session, owner, month);
  const copy = billingPreviewCopy(session.locale);
  const exceptions = billingPreviewExceptions(session.locale);
  return (
    <>
      <PageHeader title={row.owner_name} crumb={<Link href="/m/statements">{t("i_nav_stmt")}</Link>} />
      <p className="muted">{month}</p>
      <div className="card" style={{ maxWidth: 640 }}>
        <div className="bd">
          <p>
            {t("i_col_property")}：{row.properties || "—"}
          </p>
          <p>
            {t("i_fee_rule")}：{row.fee_rule || "—"}
          </p>
          {params.changed === "1" ? <p className="alert" role="alert">{copy.changed}</p> : null}
          {preview ? <div data-testid="statement-amount-preview">
            <p>{copy.period}: {preview.start} – {preview.end} · {preview.currency}</p>
            <dl>{([[copy.opening,preview.opening],[copy.rent,preview.rent],[copy.other,preview.other],[copy.fee,preview.fee],[copy.expenses,preview.expenseTotal],[copy.closing,preview.closing]] as const).map(([label,value]) => <div key={label}><dt>{label}</dt><dd>{statementSignedMoney(value,preview.currency,session.locale)}</dd></div>)}</dl>
            <h3>{copy.property}</h3><ul>{preview.propertyAmounts.map((p) => <li key={p.propertyId}>{p.name}: {statementSignedMoney(p.rent+p.utility+p.other,preview.currency,session.locale)}</li>)}</ul>
            <p>{exceptions.deposit}: {statementSignedMoney(preview.payments.reduce((sum,p) => sum+p.allocations.reduce((subtotal,a) => subtotal+a.attributed.deposit,0),0),preview.currency,session.locale)}</p>
            <p>{exceptions.residual}: {statementSignedMoney(preview.payments.reduce((sum,p) => sum+p.unallocated+p.allocations.reduce((subtotal,a) => subtotal+a.residual,0),0),preview.currency,session.locale)}</p>
            <h3>{copy.partial}</h3><ul>{preview.payments.flatMap((p) => p.allocations.flatMap((a) => a.lines.map((line) => <li key={`${a.id}:${line.id}`}>{line.description} · {copy.service}: {line.service_period ?? copy.pending} · {copy.quantity}: {line.quantity} · {copy.unit}: {line.unit_amount_minor} · {copy.amount}: {statementSignedMoney(line.amount_minor,preview.currency,session.locale)}</li>)))}</ul>
          </div> : <p className="small">{t("i_preview_pending")}</p>}
          {can(session,"stmt.generate") ? <PreviewGenerateForm ownerId={row.owner_id} month={month} label={t("s_705a524")} fingerprint={preview?.fingerprint} /> : null}
        </div>
      </div>
    </>
  );
}
