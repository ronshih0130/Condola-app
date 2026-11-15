import React from "react";
import Link from "next/link";
import { makeT } from "../../../../i18n";
import { propertyCopy } from "../../../../i18n/lanes/brand-v3-property";
import { can } from "../../../../server/perms";
import { displaySampleName } from "../../../../server/sandbox-data";
import { moneyLabel } from "../../../../server/format";
import { statusClass, statusKey } from "../../../ui";
import { ArchiveEntry } from "../../../record-archive-entry";
import type { Session } from "../../../../server/types";
import type { propertyDetail } from "../../../../server/queries";
import type * as actions from "../../../../server/actions";

export type LegacyPropertyControls = {
  session: Session;
  detail: NonNullable<Awaited<ReturnType<typeof propertyDetail>>>;
} & Pick<typeof actions, "actionSetMeter" | "actionPhoneVisibility">;

// Interim controls retain the OFF page's labels, conditions and action payloads.
// In particular, its new-lease link checks archive state only; the destination
// continues to enforce leases.edit, including for accountants.
export function PropertyLegacyControls({ session, detail, actionSetMeter, actionPhoneVisibility }: LegacyPropertyControls) {
  const t = makeT(session.locale);
  const id = detail.property.id;
  const archived = detail.property.archiveState === "archived";
  return <>
    <section className="v3-property-card v3-property-legacy" aria-labelledby="property-settings">
      <h2 id="property-settings">{propertyCopy(session.locale).settings}</h2>
      <div className="v3-property-legacy-links">
        <ArchiveEntry refValue={{kind:"property",id}} locale={session.locale} />
        {!archived && can(session, "props.edit") ? (
          <Link href={`/m/properties/${id}/edit`} data-testid="edit-property">{t("i_edit")}</Link>
        ) : null}
        {!archived && <Link href="/m/leases/new">+ {t("s_e96eefc")}</Link>}
      </div>
      <h3>{t("i_owner")}</h3>
      <p>
        {detail.owner && can(session, "props.edit") ? (
          <Link href={`/m/owners/${detail.owner.contact_id}`}>{displaySampleName(detail.owner.name)}</Link>
        ) : (
          detail.owner ? displaySampleName(detail.owner.name) : null
        )}
      </p>
      <div data-testid="repair-history">
        <h3>{t("i_repair_history")}</h3>
        {detail.repairs.length === 0 ? <p className="small muted">{t("i_repair_none")}</p> : null}
        {detail.repairs.map((repair) => (
          <div className="n" key={repair.id} data-testid={`property-repair-${repair.number}`}>
            <Link href={`/m/tickets/${repair.id}`}><b>#{repair.number} {repair.title}</b></Link>
            <div className="small muted">
              {displaySampleName(repair.place)}
              {repair.vendor_name ? ` · ${repair.vendor_name}` : ""}
              {repair.completed_on ? ` · ${repair.completed_on}` : repair.scheduled_on ? ` · ${repair.scheduled_on}` : ""}
              {repair.final_cost ? ` · ${moneyLabel(repair.final_cost, repair.currency || detail.property.currency, session.locale)}` : ""}
            </div>
            <span className={`chip ${statusClass(repair.status)}`}>{t(statusKey(repair.status))}</span>
          </div>
        ))}
        <p style={{ marginTop: 8 }}><Link href={`/m/tickets?property=${id}`}>{t("i_repair_open")}</Link></p>
      </div>
    </section>
    <div className="v3-property-card v3-property-legacy v3-property-legacy-forms">
      <div data-testid="shared-meter">
        <h3>{t("s_66a6e8b")}</h3>
        {detail.meterSerial ? (
          <p>{t("s_1dd5e87")} <b data-testid="meter-number">{detail.meterSerial}</b></p>
        ) : (
          <p data-testid="meter-number-prompt">{t("i_add_meter_prompt")}</p>
        )}
        {!archived && (session.role === "admin" || session.role === "manager") ? (
          <form action={actionSetMeter}>
            <input type="hidden" name="propertyId" value={id} />
            <div className="fg">
              <label className="f">{t("s_1dd5e87")}</label>
              <input className="inp" name="serial" data-testid="meter-serial" placeholder={t("i_ph_meter")} defaultValue="" />
            </div>
            <button className="btn sm pri" type="submit" data-testid="save-meter">{t("i_save_meter")}</button>
          </form>
        ) : null}
      </div>
      {!archived && detail.owner && (session.role === "admin" || session.role === "manager") ? (
        <form action={actionPhoneVisibility}>
          <input type="hidden" name="propertyId" value={id} />
          <input type="hidden" name="propertyOwnerId" value={detail.owner.id} />
          <label className="small v3-property-phone-visibility">
            <input type="checkbox" name="canView" defaultChecked={detail.owner.phone_visible} /> {t("i_owner_phone_vis")}
          </label>
          <div style={{ marginTop: 8 }}>
            <button className="btn sm" type="submit">{t("i_save_visibility")}</button>
          </div>
        </form>
      ) : null}
    </div>
  </>;
}
