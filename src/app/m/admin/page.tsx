import { notFound } from "next/navigation";
import { makeT } from "@/i18n";
import { ErrorBanner, PageHeader } from "@/components/ui";
import { listFlaggedFirms, listPartnerCodes } from "@/server/partners";
import { goLiveLocked, isPlatformAdmin } from "@/server/platform";
import { actionClearPriceOverride, actionCreatePartnerCode, actionSetGoLiveLock, actionSetPriceOverride } from "@/server/signup-actions";
import { getSession } from "@/server/session";

export const dynamic = "force-dynamic";

export default async function PlatformAdminPage({ searchParams }: { searchParams: Promise<{ error?: string; saved?: string }> }) {
  const session = await getSession();
  if (!isPlatformAdmin(session.email)) notFound();
  const query = await searchParams;
  const t = makeT(session.locale);
  const [codes, flagged, locked] = await Promise.all([listPartnerCodes(), listFlaggedFirms(), goLiveLocked()]);
  return (
    <>
      <PageHeader title={t("i_admin_title")} />
      <ErrorBanner t={t} error={query.error} />
      {query.saved === "1" ? <p className="alert ok">{t("i_admin_saved")}</p> : null}
      <div className="col" style={{ maxWidth: 840 }}>
        <form action={actionSetGoLiveLock} className="card pad" data-testid="admin-pause">
          <h2>{t("i_admin_pause")}</h2>
          <p className="small">{t("i_admin_pause_hint")}</p>
          <label className="radio">
            <input type="checkbox" name="locked" defaultChecked={locked} data-testid="admin-pause-toggle" />
            <span>{t("i_admin_pause")}</span>
          </label>
          <button className="btn pri" type="submit">
            {t("i_save")}
          </button>
        </form>
        <div className="card pad">
          <h2>{t("i_admin_codes")}</h2>
          <ul data-testid="admin-codes">
            {codes.map((code) => (
              <li key={code.code}>
                {code.code} · {code.partner_name} · Standard NT${code.standard_price} · {code.uses}/{code.max_uses}
                {code.active ? "" : ` · ${t("i_off")}`}
              </li>
            ))}
          </ul>
          <form action={actionCreatePartnerCode} className="col">
            <div className="fg">
              <label className="f">{t("i_signup_code")}</label>
              <input className="inp" name="code" required data-testid="admin-code" />
            </div>
            <div className="fg">
              <label className="f">{t("i_admin_partner_name")}</label>
              <input className="inp" name="partnerName" required />
            </div>
            <div className="fg">
              <label className="f">Standard</label>
              <input className="inp" name="standardPrice" type="number" min={0} required />
            </div>
            <div className="fg">
              <label className="f">Pro</label>
              <input className="inp" name="proPrice" type="number" min={0} required />
            </div>
            <div className="fg">
              <label className="f">{t("i_admin_free_units")}</label>
              <input className="inp" name="freeUnits" type="number" min={0} defaultValue={4} />
            </div>
            <div className="fg">
              <label className="f">{t("i_admin_trial")}</label>
              <input className="inp" name="trialMonths" type="number" min={0} defaultValue={3} />
            </div>
            <div className="fg">
              <label className="f">{t("i_admin_lock")}</label>
              <input className="inp" name="lockMonths" type="number" min={0} defaultValue={12} />
            </div>
            <div className="fg">
              <label className="f">{t("i_admin_max")}</label>
              <input className="inp" name="maxUses" type="number" min={1} defaultValue={1} />
            </div>
            <div className="fg">
              <label className="f">{t("i_admin_expires")}</label>
              <input className="inp" name="expiresAt" type="date" />
            </div>
            <button className="btn pri" type="submit" data-testid="admin-code-save">
              {t("i_admin_save")}
            </button>
          </form>
        </div>
        <form action={actionSetPriceOverride} className="card pad">
          <h2>{t("i_admin_override")}</h2>
          <div className="fg">
            <label className="f">{t("i_admin_org")}</label>
            <input className="inp" name="orgId" data-testid="admin-org" />
          </div>
          <div className="fg">
            <label className="f">{t("i_admin_rate")}</label>
            <input className="inp" name="rate" type="number" min={0} />
          </div>
          <button className="btn pri" type="submit">
            {t("i_admin_override_save")}
          </button>
        </form>
        <form action={actionClearPriceOverride} className="card pad">
          <div className="fg">
            <label className="f">{t("i_admin_org")}</label>
            <input className="inp" name="orgId" />
          </div>
          <button className="btn" type="submit">
            {t("i_admin_override_clear")}
          </button>
        </form>
        <div className="card pad" data-testid="admin-flagged">
          <h2>{t("i_admin_flagged")}</h2>
          {flagged.length ? (
            <ul>
              {flagged.map((firm) => (
                <li key={firm.id}>
                  {firm.name} · {firm.contact_email}
                </li>
              ))}
            </ul>
          ) : (
            <p className="small muted">{t("i_admin_none")}</p>
          )}
        </div>
      </div>
    </>
  );
}
