import Link from "next/link";
import { notFound } from "next/navigation";
import { makeT } from "@/i18n";
import { ErrorBanner, PageHeader } from "@/components/ui";
import { actionUpdateProperty } from "@/server/actions";
import { listOwners, propertyEditor } from "@/server/queries";
import { displaySampleName } from "@/server/sandbox-data";
import { getSession } from "@/server/session";

export const dynamic = "force-dynamic";

export default async function EditPropertyPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ error?: string }>;
}) {
  const { id } = await params;
  const query = await searchParams;
  const session = await getSession();
  const t = makeT(session.locale);
  const [property, owners] = await Promise.all([propertyEditor(session, id), listOwners(session)]);
  if (!property) notFound();
  const address = property.address ?? {};
  const street = address.street || address.line || "";
  const split =
    property.split_method === "days_occupied" ? "days" : property.split_method === "sub_meter" ? "sub" : property.split_method === "even" ? "even" : "";
  const major = (minor: string | null) => {
    if (!minor) return "";
    const value = Number(minor) / 100;
    return Number.isFinite(value) ? String(value) : "";
  };
  return (
    <>
      <PageHeader title={t("i_property_edit")} crumb={<Link href={`/m/properties/${id}`}>{displaySampleName(property.name)}</Link>} />
      <ErrorBanner t={t} error={query.error} />
      <form action={actionUpdateProperty}>
        <input type="hidden" name="propertyId" value={property.id} />
        <div className="card pad" style={{ maxWidth: 760 }}>
          <div className="fg">
            <label className="f">{t("i_property_name")}</label>
            <input className="inp" name="name" data-testid="property-name" defaultValue={property.name} />
          </div>
          <div className="grid2">
            <div className="fg">
              <label className="f">{t("i_city")}</label>
              <input className="inp" name="city" data-testid="property-city" defaultValue={address.city ?? ""} placeholder={t("i_ph_city")} />
            </div>
            <div className="fg">
              <label className="f">{t("i_district")}</label>
              <input className="inp" name="district" data-testid="property-district" defaultValue={address.district ?? ""} placeholder={t("i_ph_district")} />
            </div>
          </div>
          <div className="fg">
            <label className="f">{t("i_address")}</label>
            <input className="inp" name="street" data-testid="property-street" defaultValue={street} placeholder={t("i_ph_street")} />
          </div>
          <div className="fg">
            <label className="f">{t("i_owner")}</label>
            <select className="inp" name="ownerContactId" data-testid="property-owner" defaultValue={property.owner_contact_id ?? ""}>
              <option value="">{t("i_choose")}</option>
              {owners.map((owner) => (
                <option key={owner.id} value={owner.id}>
                  {owner.name}
                </option>
              ))}
            </select>
          </div>
          <div className="fg">
            <label className="f">{t("s_1dd5e87")}</label>
            <input className="inp" name="meterSerial" data-testid="meter-serial" placeholder={t("i_ph_meter")} defaultValue={property.meter_serial ?? ""} />
          </div>
          <div className="fg">
            <label className="f">{t("i_split")}</label>
            <select className="inp" name="split" data-testid="property-split" defaultValue={split}>
              <option value="">{t("i_choose")}</option>
              <option value="even">{t("s_ecf0e25")}</option>
              <option value="days">{t("s_c8e758d")}</option>
              <option value="sub">{t("s_9f8b19c")}</option>
            </select>
          </div>
          <div className="grid3">
            <div className="fg">
              <label className="f">{t("i_bill_total")}</label>
              <input className="inp" name="bill" data-testid="property-bill" inputMode="decimal" placeholder={t("i_ph_bill")} defaultValue={major(property.bill_minor)} />
            </div>
            <div className="fg">
              <label className="f">{t("i_usage")}</label>
              <input className="inp" name="usage" data-testid="property-usage" inputMode="decimal" placeholder={t("i_ph_kwh")} defaultValue={property.usage ?? ""} />
            </div>
            <div className="fg">
              <label className="f">{t("i_rate")}</label>
              <input className="inp" name="rate" data-testid="property-rate" inputMode="decimal" placeholder={t("i_ph_rate")} defaultValue={major(property.rate_minor)} />
            </div>
          </div>
          <button className="btn pri" type="submit" data-testid="save-property">
            {t("i_save")}
          </button>
        </div>
      </form>
    </>
  );
}
