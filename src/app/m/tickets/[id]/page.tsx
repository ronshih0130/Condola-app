import Link from "next/link";
import { headers } from "next/headers";
import { notFound } from "next/navigation";
import { makeT } from "@/i18n";
import { RepairThread } from "@/components/repair-thread";
import { VendorDispatch } from "@/components/vendor-dispatch";
import { ErrorBanner, PageHeader, statusKey } from "@/components/ui";
import { COST_BEARER_KEY, REPAIR_CAT_KEY, REPAIR_STATUSES } from "@/lib/repair-labels";
import { actionSaveRepair } from "@/server/actions";
import { can, rolesFor } from "@/server/perms";
import { isUuid, minorToInput } from "@/server/repair-rules";
import { ticketDetail } from "@/server/queries";
import { displaySampleName } from "@/server/sandbox-data";
import { getSession } from "@/server/session";
import { loadVendorDispatch } from "@/server/vendor-repair";

export const dynamic = "force-dynamic";

export default async function TicketDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ error?: string }>;
}) {
  const { id } = await params;
  if (!isUuid(id)) notFound();
  const session = await getSession();
  const t = makeT(session.locale);
  const query = await searchParams;
  const detail = await ticketDetail(session, id);
  if (!detail) notFound();
  const canWrite = can(session.role, "tickets.update");
  const canPost = can(session.role, "exp.add");
  const headerList = await headers();
  const host = headerList.get("x-forwarded-host") || headerList.get("host") || "";
  const proto = headerList.get("x-forwarded-proto") || (host.startsWith("localhost") || host.startsWith("127.") ? "http" : "https");
  const dispatch = await loadVendorDispatch(session, id, host ? `${proto}://${host}` : "");
  const ticket = detail.ticket;
  const currency = ticket.currency || ticket.property_currency;
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
      <PageHeader
        title={`#${ticket.number} ${ticket.title}`}
        crumb={<Link href="/m/tickets">{t("i_repair_history")}</Link>}
      />
      <ErrorBanner t={t} error={query.error} />
      <p className="muted">
        <Link href={`/m/properties/${ticket.property_id}`} data-testid="repair-property">
          {displaySampleName(ticket.property_name)}
        </Link>
        {displaySampleName(ticket.place.replace(ticket.property_name, ""))} · {t(REPAIR_CAT_KEY[ticket.category] ?? "i_cat_other")}
      </p>
      {ticket.description ? <p>{ticket.description}</p> : null}
      <div className="grid2">
        <form className="card pad" action={canWrite ? actionSaveRepair : undefined} data-testid="repair-record">
          <input type="hidden" name="ticketId" value={ticket.id} />
          <div className="fg">
            <label className="f">{t("i_status")}</label>
            <select className="inp" name="status" defaultValue={ticket.status} disabled={!canWrite} data-testid="repair-status">
              {REPAIR_STATUSES.map((status) => (
                <option key={status} value={status}>
                  {t(statusKey(status))}
                </option>
              ))}
            </select>
          </div>
          <div className="fg">
            <label className="f">{t("i_repair_vendor")}</label>
            <input className="inp" name="vendorName" defaultValue={ticket.vendor_name ?? ""} disabled={!canWrite} data-testid="repair-vendor" />
          </div>
          <div className="fg">
            <label className="f">
              {t("i_repair_estimate")} ({currency})
            </label>
            <input
              className="inp"
              name="estimated"
              inputMode="decimal"
              defaultValue={minorToInput(ticket.estimated_cost)}
              disabled={!canWrite}
              data-testid="repair-estimate"
            />
          </div>
          <div className="fg">
            <label className="f">
              {t("i_repair_final")} ({currency})
            </label>
            <input
              className="inp"
              name="finalCost"
              inputMode="decimal"
              defaultValue={minorToInput(ticket.final_cost)}
              disabled={!canWrite}
              data-testid="repair-final"
            />
          </div>
          <div className="fg">
            <label className="f">{t("i_repair_bearer")}</label>
            <select className="inp" name="costBearer" defaultValue={ticket.cost_bearer} disabled={!canWrite} data-testid="repair-bearer">
              {Object.entries(COST_BEARER_KEY).map(([value, key]) => (
                <option key={value} value={value}>
                  {t(key)}
                </option>
              ))}
            </select>
          </div>
          <div className="fg">
            <label className="f">{t("i_repair_scheduled")}</label>
            <input className="inp" type="date" name="scheduledOn" defaultValue={ticket.scheduled_on ?? ""} disabled={!canWrite} data-testid="repair-scheduled" />
          </div>
          <div className="fg">
            <label className="f">{t("i_repair_completed")}</label>
            <input className="inp" type="date" name="completedOn" defaultValue={ticket.completed_on ?? ""} disabled={!canWrite} data-testid="repair-completed" />
          </div>
          <div className="fg">
            <label className="f">{t("i_note")}</label>
            <textarea className="inp" name="note" defaultValue="" disabled={!canWrite} data-testid="repair-note" />
          </div>
          {canWrite ? (
            <label className="small">
              <input type="checkbox" name="internal" /> {t("i_repair_internal")}
            </label>
          ) : null}
          {ticket.expense_id && ticket.expense_status !== "void" ? (
            <p data-testid="repair-expense-linked">{t("i_repair_expense_linked")}</p>
          ) : canPost && canWrite ? (
            <label className="small">
              <input type="checkbox" name="postExpense" data-testid="repair-post-expense" /> {t("i_repair_post_expense")}
              <div className="tiny muted">{t("i_repair_expense_hint")}</div>
            </label>
          ) : null}
          <div style={{ marginTop: 12 }}>
            <button
              className="btn pri"
              type="submit"
              disabled={!canWrite}
              aria-disabled={!canWrite}
              title={canWrite ? undefined : need}
              data-testid={canWrite ? "repair-save" : "repair-save-disabled"}
            >
              {t("i_repair_save")}
            </button>
          </div>
          {canWrite ? null : <p className="tiny muted">{need}</p>}
        </form>
        <div className="card pad">
          <RepairThread
            ticketId={ticket.id}
            comments={detail.comments}
            photos={detail.photos}
            t={t}
            locale={session.locale}
            calendar={session.calendar}
            canComment={canWrite}
            canUpload={canWrite}
            allowInternal={canWrite}
            returnTo="staff"
          />
        </div>
      </div>
      {dispatch ? (
        <VendorDispatch
          ticketId={ticket.id}
          canDispatch={canWrite}
          canConfirm={canWrite && canPost}
          job={dispatch.job}
          currency={currency}
          t={t}
          locale={session.locale}
          calendar={session.calendar}
        />
      ) : null}
    </>
  );
}
