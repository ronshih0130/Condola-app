import Link from "next/link";
import { makeT } from "@/i18n";
import { FooterNote } from "@/components/chrome";
import { PageHeader } from "@/components/ui";
import { formatMoney } from "@/server/format";
import { dashboard } from "@/server/queries";
import { getSession } from "@/server/session";

export const dynamic = "force-dynamic";

export default async function DashboardPage() {
  const session = await getSession();
  const t = makeT(session.locale);
  const data = await dashboard(session);
  const money = (minor: number) => formatMoney(minor, "TWD", session.locale);
  return (
    <>
      <PageHeader
        title={t("i_morning", { name: session.name })}
        actions={
          <>
            <Link className="btn" href="/m/leases/new">
              + {t("s_e96eefc")}
            </Link>
            <Link className="btn pri" href="/m/properties/new">
              + {t("s_aed91da")}
            </Link>
          </>
        }
      />
      <div className="grid5" style={{ marginBottom: 16 }}>
        <Link className="card kpi" href="/m/rent">
          <div className="lbl">{t("i_paid")}</div>
          <div className="val">{money(data.received)}</div>
        </Link>
        <Link className="card kpi" href="/m/rent">
          <div className="lbl">{t("i_open_balance")}</div>
          <div className="val">{money(data.outstanding)}</div>
          <div className="sub">{t("i_tenant_count", { count: data.owingCount })}</div>
        </Link>
        <Link className="card kpi" href="/m/payments">
          <div className="lbl">{t("i_pending_pay")}</div>
          <div className="val">{data.pending}</div>
        </Link>
        <Link className="card kpi" href="/m/tickets">
          <div className="lbl">{t("i_nav_tickets")}</div>
          <div className="val">{data.tickets}</div>
        </Link>
        <Link className="card kpi" href="/m/leases">
          <div className="lbl">{t("i_occ")}</div>
          <div className="val">
            {data.occupied}/{data.rooms}
          </div>
        </Link>
      </div>
      <div className="grid2">
        <div className="card">
          <div className="hd">
            <h3>{t("i_nav_props")}</h3>
          </div>
          <div className="bd">
            {data.properties.map((property) => {
              const billed = Number(property.billed);
              const received = Number(property.received);
              const width = billed > 0 ? Math.min(100, (received / billed) * 100) : 0;
              return (
                <div key={property.id} style={{ marginBottom: 12 }}>
                  <div className="row small">
                    <b>{property.name}</b>
                    <span className="sp" />
                    {money(received)} / {money(billed)}
                  </div>
                  <div className="bar">
                    <i style={{ width: `${width}%` }} />
                  </div>
                </div>
              );
            })}
          </div>
        </div>
        <div className="card">
          <div className="hd">
            <h3>{t("i_open_balance")}</h3>
          </div>
          <table className="t">
            <tbody>
              {data.owing.length === 0 ? (
                <tr>
                  <td className="empty">{t("i_empty")}</td>
                </tr>
              ) : (
                data.owing.map((row) => (
                  <tr key={row.lease_id}>
                    <td>
                      <Link href={`/m/leases/${row.lease_id}?tab=ledger`}>{row.tenant}</Link>
                    </td>
                    <td className="small">{row.place}</td>
                    <td className="num">{formatMoney(Number(row.balance), row.currency, session.locale)}</td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>
      <FooterNote />
    </>
  );
}
