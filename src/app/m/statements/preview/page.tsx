import Link from "next/link";
import { redirect } from "next/navigation";
import { makeT } from "@/i18n";
import { PageHeader } from "@/components/ui";
import { PreviewGenerateForm } from "@/components/dialogs";
import { formatMailMonth } from "@/server/mail-copy";
import { statementRoster } from "@/server/queries";
import { getSession } from "@/server/session";

export const dynamic = "force-dynamic";

export default async function StatementPreviewPage({
  searchParams,
}: {
  searchParams: Promise<{ owner?: string; month?: string }>;
}) {
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
  return (
    <>
      <PageHeader title={row.owner_name} crumb={<Link href="/m/statements">{t("i_nav_stmt")}</Link>} />
      <p className="muted">{formatMailMonth(month)}</p>
      <div className="card" style={{ maxWidth: 640 }}>
        <div className="bd">
          <p>
            {t("i_col_property")}：{row.properties || "—"}
          </p>
          <p>
            {t("i_fee_rule")}：{row.fee_rule || "—"}
          </p>
          <p className="small">{t("i_preview_pending")}</p>
          <PreviewGenerateForm ownerId={row.owner_id} month={month} label={t("s_705a524")} />
        </div>
      </div>
    </>
  );
}
