import type { T } from "@/i18n";

export function OwnerForm({
  t,
  action,
  ownerId,
  name,
  email,
  phone,
  properties,
  selected,
}: {
  t: T;
  action: (formData: FormData) => void;
  ownerId?: string;
  name?: string;
  email?: string;
  phone?: string;
  properties: { id: string; name: string }[];
  selected: string[];
}) {
  return (
    <form action={action}>
      {ownerId ? <input type="hidden" name="ownerId" value={ownerId} /> : null}
      <div className="card pad" style={{ maxWidth: 720 }}>
        <div className="fg">
          <label className="f">{t("i_owner")}</label>
          <input className="inp" name="name" data-testid="owner-name" defaultValue={name ?? ""} placeholder={t("i_ph_owner")} required />
        </div>
        <div className="grid2">
          <div className="fg">
            <label className="f">{t("i_owner_email")}</label>
            <input className="inp" name="email" type="email" data-testid="owner-email" defaultValue={email ?? ""} placeholder={t("i_ph_email")} required />
          </div>
          <div className="fg">
            <label className="f">{t("i_phone_label")}</label>
            <input className="inp" name="phone" data-testid="owner-phone" defaultValue={phone ?? ""} placeholder={t("i_ph_phone")} />
          </div>
        </div>
        <div className="fg">
          <div className="f">{t("i_assign_properties")}</div>
          {properties.length === 0 ? <p className="hint">{t("i_empty")}</p> : null}
          {properties.map((property) => (
            <label className="small" key={property.id} style={{ display: "block", marginTop: 6 }}>
              <input
                type="checkbox"
                name="propertyId"
                value={property.id}
                data-testid={`owner-property-${property.id}`}
                defaultChecked={selected.includes(property.id)}
              />{" "}
              {property.name}
            </label>
          ))}
        </div>
        <button className="btn pri" type="submit" data-testid="save-owner">
          {t("i_save")}
        </button>
      </div>
    </form>
  );
}
