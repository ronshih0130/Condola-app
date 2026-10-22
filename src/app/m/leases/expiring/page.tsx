import Link from "next/link";
import { notFound } from "next/navigation";
import { PageHeader } from "@/components/ui";
import { makeT } from "@/i18n";
import { lifecycleEnabledFor, listExpiring, type ExpiryStatus } from "@/server/lease-lifecycle";
import { COPY, remainingDaysLabel } from "@/server/lease-lifecycle-rules";
import { displaySampleName } from "@/server/sandbox-data";
import { getSession } from "@/server/session";

export const dynamic = "force-dynamic";

const FILTERS: Array<ExpiryStatus | "all"> = ["all", "undecided", "renewing", "scheduled"];

function filterLabel(status: ExpiryStatus | "all") {
  if (status === "undecided") return COPY.undecided;
  if (status === "renewing") return COPY.renewing;
  if (status === "scheduled") return COPY.scheduled;
  return COPY.statusAll;
}

function statusLabel(status: ExpiryStatus) {
  if (status === "renewing") return COPY.renewing;
  if (status === "scheduled") return COPY.scheduled;
  return COPY.undecided;
}

export default async function ExpiringLeasesPage({ searchParams }: { searchParams: Promise<{ status?: string }> }) {
  const session = await getSession();
  if (session.kind !== "staff" || !(await lifecycleEnabledFor(session))) notFound();
  if (session.role !== "admin" && session.role !== "manager" && session.role !== "accountant") notFound();
  const t = makeT(session.locale);
  const raw = await searchParams;
  const status = FILTERS.includes(raw.status as ExpiryStatus | "all") ? (raw.status as ExpiryStatus | "all") : "all";
  const rows = await listExpiring(session, status);
  const canWrite = session.role === "admin" || session.role === "manager";
  return (
    <>
      <PageHeader title={COPY.listTitle} crumb={<Link href="/m/leases">{t("i_nav_leases")}</Link>} />
      <div className="row" data-testid="expiring-filters">
        <span className="chip" data-testid="expiring-window">{COPY.window}</span>
        {FILTERS.map((item) => (
          <Link key={item} className={item === status ? "btn pri" : "btn"} href={item === "all" ? "/m/leases/expiring" : `/m/leases/expiring?status=${item}`} data-testid={`filter-${item}`}>
            {filterLabel(item)}
          </Link>
        ))}
      </div>
      {status === "all" && rows.length === 0 ? (
        <div className="empty" data-testid="expiring-empty">
          <h2>{COPY.emptyTitle}</h2>
          <p>{COPY.emptyBody}</p>
        </div>
      ) : (
        <div className="card">
          <table className="t" data-testid="expiring-list">
            <thead>
              <tr>
                <th>{COPY.colParty}</th>
                <th>{COPY.colEnd}</th>
                <th>{COPY.colDays}</th>
                <th>{COPY.colStatus}</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.id} data-testid="expiring-row">
                  <td>{displaySampleName(row.tenant)}・{displaySampleName(row.place)}</td>
                  <td>{row.endDate}</td>
                  <td>{remainingDaysLabel(row.days)}</td>
                  <td>
                    <span data-testid="expiring-status-label">{statusLabel(row.status)}</span>
                    {row.status === "renewing" && row.successorPending ? <div className="small">{COPY.pendingNote}</div> : null}
                  </td>
                  <td>
                    {canWrite && row.status === "undecided" ? (
                      <Link className="btn" href={`/m/leases/${row.id}/renew`} data-testid="row-renew">{COPY.renew}</Link>
                    ) : null}{" "}
                    {canWrite && row.status !== "scheduled" ? (
                      <Link className="btn" href={`/m/leases/${row.id}/moveout`} data-testid="row-moveout">{COPY.moveOut}</Link>
                    ) : null}{" "}
                    {canWrite && row.status === "scheduled" ? (
                      <Link className="btn pri" href={`/m/leases/${row.id}/settlement`} data-testid="row-settle">{COPY.settle}</Link>
                    ) : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}
