import Link from "next/link";
import { makeT } from "@/i18n";
import { PageHeader } from "@/components/ui";
import { formatMoney } from "@/server/format";
import { listProperties, propertyDetail } from "@/server/queries";
import { getSession } from "@/server/session";

export const dynamic = "force-dynamic";

export default async function UnitsPage() {
  const session = await getSession();
  const t = makeT(session.locale);
  const properties = await listProperties(session);
  const details = await Promise.all(properties.map((property) => propertyDetail(session, property.id)));
  return (
    <>
      <PageHeader title={t("i_units_title")} />
      {details.map((detail) =>
        detail ? (
          <div className="card" key={detail.property.id} style={{ marginBottom: 12 }}>
            <div className="hd">
              <h3>
                <Link href={`/m/properties/${detail.property.id}`}>{detail.property.name}</Link>
              </h3>
            </div>
            <table className="t">
              <tbody>
                {detail.rooms.map((room) => (
                  <tr key={room.id}>
                    <td>
                      {room.unit_label} {room.label}
                    </td>
                    <td>{t(room.room_type === "suite" ? "i_suite" : room.room_type === "shared_bath" ? "i_shared" : "i_other_room")}</td>
                    <td className="num">{formatMoney(Number(room.base_rent_minor), detail.property.currency, session.locale)}</td>
                    <td>{room.tenant ?? t("i_vacant")}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : null,
      )}
    </>
  );
}
