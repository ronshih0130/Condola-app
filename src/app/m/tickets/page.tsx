import Link from "next/link";
import { makeT } from "@/i18n";
import { ErrorBanner, PageHeader, statusClass, statusKey } from "@/components/ui";
import { REPAIR_CATS, REPAIR_CAT_KEY } from "@/lib/repair-labels";
import { actionTicket, actionUpdateTicket } from "@/server/actions";
import { formatMoney } from "@/server/format";
import { can, rolesFor } from "@/server/perms";
import { isUuid } from "@/server/repair-rules";
import { listLeases, listTicketProperties, listTickets } from "@/server/queries";
import { getSession } from "@/server/session";

export const dynamic = "force-dynamic";

export default async function TicketsPage({ searchParams }: { searchParams: Promise<{ error?: string; property?: string }> }) {
  const session = await getSession();
  const t = makeT(session.locale);
  const params = await searchParams;
  const propertyId = params.property && isUuid(params.property) ? params.property : "";
  const [tickets, leases, properties] = await Promise.all([
    listTickets(session, propertyId || null),
    listLeases(session),
    listTicketProperties(session),
  ]);
  const canWrite = can(session.role, "tickets.update");
  const roleLabel: Record<string, string> = {
    admin: "i_role_admin",
    manager: "i_role_manager",
    accountant: "i_role_accountant",
    maintenance: "i_role_maintenance",
  };
  const need = t("pm_need", {
    roles: rolesFor("tickets.update")
      .map((role) => t(roleLabel[role]))
      .join(t("i_list_sep")),
  });
  return (
    <>
      <PageHeader title={t("i_repair_history")} />
      <ErrorBanner t={t} error={params.error} />
      <form method="get" className="row" style={{ marginBottom: 12 }} data-testid="repair-property-filter">
        <select className="inp" name="property" defaultValue={propertyId} aria-label={t("i_repair_filter")}>
          <option value="">{t("i_repair_all")}</option>
          {properties.map((property) => (
            <option key={property.id} value={property.id}>
              {property.name}
            </option>
          ))}
        </select>
        <button className="btn sm" type="submit">
          {t("i_repair_filter")}
        </button>
      </form>
      <div className="grid2">
        <div className="card">
          <table className="t rf">
            <tbody>
              {tickets.map((ticket) => (
                <tr key={ticket.id} data-testid={`ticket-row-${ticket.number}`}>
                  <td>
                    <b>
                      <Link href={`/m/tickets/${ticket.id}`} data-testid={`ticket-open-${ticket.number}`}>
                        #{ticket.number} {ticket.title}
                      </Link>
                    </b>
                    <div className="small muted">
                      {ticket.place} · {t(REPAIR_CAT_KEY[ticket.category] ?? "i_cat_other")}
                      {ticket.vendor_name ? ` · ${ticket.vendor_name}` : ""}
                      {ticket.scheduled_on ? ` · ${ticket.scheduled_on}` : ""}
                    </div>
                    {ticket.final_cost ? (
                      <div className="small">{formatMoney(ticket.final_cost, ticket.currency || "TWD", session.locale)}</div>
                    ) : null}
                    <form action={canWrite ? actionUpdateTicket : undefined} className="row" style={{ marginTop: 6 }}>
                      <input type="hidden" name="ticketId" value={ticket.id} />
                      <select className="inp" name="status" defaultValue={ticket.status} disabled={!canWrite}>
                        {["open", "triaged", "in_progress", "on_hold", "resolved", "closed"].map((status) => (
                          <option key={status} value={status}>
                            {t(statusKey(status))}
                          </option>
                        ))}
                      </select>
                      <input className="inp" name="note" placeholder={t("i_note")} disabled={!canWrite} />
                      <button
                        className="btn sm"
                        type="submit"
                        disabled={!canWrite}
                        aria-disabled={!canWrite}
                        title={canWrite ? undefined : need}
                        data-testid={canWrite ? "ticket-update" : "ticket-update-disabled"}
                      >
                        {t("i_update")}
                      </button>
                    </form>
                  </td>
                  <td data-label={t("i_status")}>
                    <span className={`chip ${statusClass(ticket.status)}`}>{t(statusKey(ticket.status))}</span>
                  </td>
                </tr>
              ))}
              {tickets.length === 0 ? (
                <tr>
                  <td className="muted">{t("i_repair_none")}</td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </div>
        <form className="card pad" action={canWrite ? actionTicket : undefined}>
          <input type="hidden" name="returnTo" value="staff" />
          <div className="fg">
            <label className="f">{t("i_select_lease")}</label>
            <select className="inp" name="leaseId" defaultValue="" disabled={!canWrite}>
              <option value="">{t("i_choose")}</option>
              {leases.map((lease) => (
                <option key={lease.id} value={lease.id}>
                  {lease.tenant} · {lease.place}
                </option>
              ))}
            </select>
          </div>
          <div className="fg">
            <label className="f">{t("i_category")}</label>
            <select className="inp" name="category" defaultValue="" disabled={!canWrite}>
              <option value="">{t("i_choose")}</option>
              {REPAIR_CATS.map((cat) => (
                <option key={cat} value={cat}>
                  {t(REPAIR_CAT_KEY[cat])}
                </option>
              ))}
            </select>
          </div>
          <div className="fg">
            <label className="f">{t("i_title")}</label>
            <input className="inp" name="title" placeholder={t("i_ph_title")} defaultValue="" disabled={!canWrite} />
          </div>
          <div className="fg">
            <label className="f">{t("i_description")}</label>
            <textarea className="inp" name="description" defaultValue="" disabled={!canWrite} />
          </div>
          <button
            className="btn pri"
            type="submit"
            disabled={!canWrite}
            aria-disabled={!canWrite}
            title={canWrite ? undefined : need}
            data-testid={canWrite ? "ticket-create" : "ticket-create-disabled"}
          >
            {t("i_submit_repair")}
          </button>
          {canWrite ? null : <p className="tiny muted">{need}</p>}
        </form>
      </div>
    </>
  );
}
