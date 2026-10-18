import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { makeT } from "@/i18n";
import { PageHeader } from "@/components/ui";
import { actionStatement } from "@/server/actions";
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
  if (!month || !/^[0-9a-f-]{36}$/i.test(owner)) notFound();
  const roster = await statementRoster(session, month);
  const row = roster.find((item) => item.owner_id === owner && item.period_start.slice(0, 7) === month);
  if (!row) notFound();
  if (row.id) redirect(`/m/statements/${row.id}`);
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
          <p className="small">{t("i_preview_pending")}</p>
          <form action={actionStatement}>
            <input type="hidden" name="ownerContactId" value={row.owner_id} />
            <input type="hidden" name="month" value={month} />
            <button className="btn pri" type="submit">
              {t("s_705a524")}
            </button>
          </form>
        </div>
      </div>
    </>
  );
}
