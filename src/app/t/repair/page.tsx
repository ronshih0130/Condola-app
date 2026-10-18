import { makeT } from "@/i18n";
import { ErrorBanner } from "@/components/ui";
import { actionTicket } from "@/server/actions";
import { selectedLease } from "@/lib/tenant-lease";

export const dynamic = "force-dynamic";

export default async function RepairPage({ searchParams }: { searchParams: Promise<{ error?: string; done?: string }> }) {
  const { session, lease } = await selectedLease();
  const t = makeT(session.locale);
  const params = await searchParams;
  if (!lease) return <p>{t("i_empty")}</p>;
  return (
    <div>
      <h2>{t("i_rich_repair")}</h2>
      <ErrorBanner t={t} error={params.error} />
      {params.done ? <div className="alert ok">{t("i_repair_sent", { firm: lease.firm_name })}</div> : null}
      <form action={actionTicket}>
        <input type="hidden" name="leaseId" value={lease.lease_id} />
        <div className="fg">
          <label className="f">{t("i_category")}</label>
          <select className="inp" name="category" data-testid="repair-category" defaultValue="">
            <option value="">{t("i_choose")}</option>
            <option value="plumbing">{t("i_cat_plumbing")}</option>
            <option value="electrical">{t("i_cat_electrical")}</option>
            <option value="appliance">{t("i_cat_appliance")}</option>
            <option value="hvac">{t("i_cat_hvac")}</option>
            <option value="other">{t("i_cat_other")}</option>
          </select>
        </div>
        <div className="fg">
          <label className="f">{t("i_title")}</label>
          <input className="inp" name="title" data-testid="repair-title" placeholder={t("i_ph_title")} defaultValue="" />
        </div>
        <div className="fg">
          <label className="f">{t("i_description")}</label>
          <textarea className="inp" name="description" defaultValue="" />
        </div>
        <button className="btn pri block" type="submit" data-testid="submit-repair">
          {t("i_submit_repair")}
        </button>
      </form>
    </div>
  );
}
