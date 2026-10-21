import { makeT } from "@/i18n";
import { ownerPrivacy } from "@/server/auth";
import { formatMoney } from "@/server/format";
import { ownerHome } from "@/server/queries";
import { getSession } from "@/server/session";

export const dynamic = "force-dynamic";

export default async function OwnerHomePage() {
  const session = await getSession();
  const t = makeT(session.locale);
  const [rows, privacy] = await Promise.all([ownerHome(session), ownerPrivacy(session.orgId)]);
  return (
    <div>
      <h2>{t("i_hello", { name: session.name })}</h2>
      <p className="small" data-testid="managed-by">{t("i_managed_by", { firm: privacy.name, brand: t("i_brand") })}</p>
      <table className="t">
        <tbody>
          {rows.map((row) => (
            <tr key={row.lease_id}>
              <td>
                <b data-testid="tenant-name">{privacy.showName ? row.tenant_name : t("i_tenant_hidden")}</b>
                <div className="small muted">
                  {row.property_name} {row.unit_label} {row.room_label}
                </div>
              </td>
              <td className="num">{formatMoney(Number(row.rent), row.currency, session.locale)}</td>
              <td
                data-testid="tenant-phone"
                data-visible={privacy.showPhone && row.phone_visible ? "true" : "false"}
              >
                {privacy.showPhone && row.phone_visible && row.tenant_phone ? row.tenant_phone : t("i_phone_hidden")}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
