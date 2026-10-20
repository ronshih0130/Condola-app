import { makeT } from "@/i18n";
import { ErrorBanner, PageHeader, statusClass, statusKey } from "@/components/ui";
import { actionTicket, actionUpdateTicket } from "@/server/actions";
import { can, rolesFor } from "@/server/perms";
import { listLeases, listTickets } from "@/server/queries";
import { getSession } from "@/server/session";

export const dynamic = "force-dynamic";

const CATS = ["plumbing", "electrical", "appliance", "hvac", "structural", "pest", "locks_keys", "internet", "cleaning", "other"] as const;
const CAT_KEY: Record<string, string> = {
  plumbing: "i_cat_plumbing",
  electrical: "i_cat_electrical",
  appliance: "i_cat_appliance",
  hvac: "i_cat_hvac",
  structural: "i_cat_structural",
  pest: "i_cat_pest",
  locks_keys: "i_cat_locks",
  internet: "i_cat_internet",
  cleaning: "i_cat_cleaning",
  other: "i_cat_other",
};

export default async function TicketsPage({ searchParams }: { searchParams: Promise<{ error?: string }> }) {
  const session = await getSession();
  const t = makeT(session.locale);
  const params = await searchParams;
  const [tickets, leases] = await Promise.all([listTickets(session), listLeases(session)]);
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
      <PageHeader title={t("i_nav_tickets")} />
      <ErrorBanner t={t} error={params.error} />
      <div className="grid2">
        <div className="card">
          <table className="t rf">
            <tbody>
              {tickets.map((ticket) => (
                <tr key={ticket.id}>
                  <td>
                    <b>#{ticket.number}</b> {ticket.title}
                    <div className="small muted">
                      {ticket.place} · {t(CAT_KEY[ticket.category] ?? "i_cat_other")}
                    </div>
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
                {CATS.map((cat) => (
                  <option key={cat} value={cat}>
                    {t(CAT_KEY[cat])}
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
