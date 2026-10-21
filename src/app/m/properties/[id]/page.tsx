import Link from "next/link";
import { notFound } from "next/navigation";
import { makeT } from "@/i18n";
import { actionPhoneVisibility, actionSetMeter } from "@/server/actions";
import { AuditHistory } from "@/components/audit-log";
import { ErrorBanner, PageHeader, statusClass, statusKey } from "@/components/ui";
import { displaySampleName } from "@/server/sandbox-data";
import { formatMoney } from "@/server/format";
import { can } from "@/server/perms";
import { propertyDetail } from "@/server/queries";
import { getSession } from "@/server/session";

export const dynamic = "force-dynamic";

export default async function PropertyPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ error?: string; audit?: string; created?: string }>;
}) {
  const { id } = await params;
  const query = await searchParams;
  const session = await getSession();
  const t = makeT(session.locale);
  const detail = await propertyDetail(session, id);
  if (!detail) notFound();
  return (
    <>
      <PageHeader
        title={
          <>
            {displaySampleName(detail.property.name)}
          </>
        }
        crumb={<Link href="/m/properties">{t("s_e03a6ec")}</Link>}
        actions={
          <>
            {can(session.role, "props.edit") ? (
              <Link className="btn" href={`/m/properties/${id}/edit`} data-testid="edit-property">
                {t("i_edit")}
              </Link>
            ) : null}
            <Link className="btn pri" href="/m/leases/new">
              + {t("s_e96eefc")}
            </Link>
          </>
        }
      />
      <p className="muted">{detail.property.address_display}</p>
      {query.created === "1" ? (
        <p className="alert ok" data-testid="property-created">
          {t("i_created_prop")}
        </p>
      ) : null}
      <ErrorBanner t={t} error={query.error} />
      <div className="grid2">
        <div className="card">
          <div className="hd">
            <h3>{t("s_a757163")}</h3>
          </div>
          <div className="bd tree">
            {detail.wholes.map((unit) => (
              <div className="n" key={unit.id} data-testid="whole-unit-saved">
                <b>{displaySampleName(unit.label)}</b>
                <span className="small muted">{formatMoney(Number(unit.base_rent_minor), detail.property.currency, session.locale)}</span>
              </div>
            ))}
            {detail.rooms.map((room) => (
              <div className="n" key={room.id}>
                <b>
                  {displaySampleName(room.unit_label)} {displaySampleName(room.label)}
                </b>
                <span className="small muted">{formatMoney(Number(room.base_rent_minor), detail.property.currency, session.locale)}</span>
                <span className="sp" />
                {room.lease_id ? (
                  <Link href={`/m/leases/${room.lease_id}`}>{displaySampleName(room.tenant || "")}</Link>
                ) : (
                  <span className="chip bad">{t("i_vacant")}</span>
                )}
              </div>
            ))}
          </div>
        </div>
        <div className="card pad">
          <h3>{t("i_owner")}</h3>
          <p>
            {detail.owner && can(session.role, "props.edit") ? (
              <Link href={`/m/owners/${detail.owner.contact_id}`}>{displaySampleName(detail.owner.name)}</Link>
            ) : (
              detail.owner ? displaySampleName(detail.owner.name) : null
            )}
          </p>
          {detail.owner && (session.role === "admin" || session.role === "manager") ? (
            <form action={actionPhoneVisibility}>
              <input type="hidden" name="propertyId" value={id} />
              <input type="hidden" name="propertyOwnerId" value={detail.owner.id} />
              <label className="small">
                <input type="checkbox" name="canView" defaultChecked={detail.owner.phone_visible} /> {t("i_owner_phone_vis")}
              </label>
              <div style={{ marginTop: 8 }}>
                <button className="btn sm" type="submit">
                  {t("i_save_visibility")}
                </button>
              </div>
            </form>
          ) : null}
        </div>
        <div className="card pad" data-testid="repair-history">
          <h3>{t("i_repair_history")}</h3>
          {detail.repairs.length === 0 ? <p className="small muted">{t("i_repair_none")}</p> : null}
          {detail.repairs.map((repair) => (
            <div className="n" key={repair.id} data-testid={`property-repair-${repair.number}`}>
              <Link href={`/m/tickets/${repair.id}`}>
                <b>
                  #{repair.number} {repair.title}
                </b>
              </Link>
              <div className="small muted">
                {displaySampleName(repair.place)}
                {repair.vendor_name ? ` · ${repair.vendor_name}` : ""}
                {repair.completed_on ? ` · ${repair.completed_on}` : repair.scheduled_on ? ` · ${repair.scheduled_on}` : ""}
                {repair.final_cost ? ` · ${formatMoney(repair.final_cost, repair.currency || detail.property.currency, session.locale)}` : ""}
              </div>
              <span className={`chip ${statusClass(repair.status)}`}>{t(statusKey(repair.status))}</span>
            </div>
          ))}
          <p style={{ marginTop: 8 }}>
            <Link href={`/m/tickets?property=${id}`}>{t("i_repair_open")}</Link>
          </p>
        </div>
        <div className="card pad" data-testid="shared-meter">
          <h3>{t("s_66a6e8b")}</h3>
          {detail.meterSerial ? (
            <p>
              {t("s_1dd5e87")} <b data-testid="meter-number">{detail.meterSerial}</b>
            </p>
          ) : (
            <p data-testid="meter-number-prompt">{t("i_add_meter_prompt")}</p>
          )}
          {session.role === "admin" || session.role === "manager" ? (
            <form action={actionSetMeter}>
              <input type="hidden" name="propertyId" value={id} />
              <div className="fg">
                <label className="f">{t("s_1dd5e87")}</label>
                <input className="inp" name="serial" data-testid="meter-serial" placeholder={t("i_ph_meter")} defaultValue="" />
              </div>
              <button className="btn sm pri" type="submit" data-testid="save-meter">
                {t("i_save_meter")}
              </button>
            </form>
          ) : null}
        </div>
      </div>
      <AuditHistory table="properties" rowId={id} cursor={query.audit} path={`/m/properties/${id}`} preserve={{ error: query.error }} />
    </>
  );
}
