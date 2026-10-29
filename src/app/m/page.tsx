import { requireCurrentConsent } from "@/server/consent-gate";
import Link from "next/link";
import { dictionary, makeT } from "@/i18n";
import { FooterNote } from "@/components/chrome";
import { Cell, RfTable } from "@/components/rf";
import { PageHeader } from "@/components/ui";
import { brandV2Enabled } from "@/server/brand-v2";
import { showDemoLineCopy } from "@/server/demo";
import { formatDate, moneyLabel } from "@/server/format";
import { dashboard } from "@/server/queries";
import { displaySampleName } from "@/server/sandbox-data";
import { getSession } from "@/server/session";

export const dynamic = "force-dynamic";

export default async function DashboardPage({
  searchParams,
}: {
  searchParams: Promise<{ dupFirm?: string; code?: string }>;
}) {
  const v2 = brandV2Enabled();
  await requireCurrentConsent(undefined, "page");
  const session = await getSession();
  const query = await searchParams;
  const t = makeT(session.locale);
  const data = await dashboard(session);
  const dict = dictionary(session.locale);
  const money = (minor: number | string, currency = "TWD") => moneyLabel(minor, currency, session.locale);
  return (
    <>
      <PageHeader
        title={t("i_morning", { name: session.name })}
        actions={
          <>
            <Link className="btn" href="/m/leases/new" data-v2-page={v2 ? "m-home" : undefined} data-v2-action={v2 ? "secondary" : undefined}>
              + {t("s_e96eefc")}
            </Link>
            <Link className="btn pri" href="/m/properties/new" data-v2-page={v2 ? "m-home" : undefined} data-v2-action={v2 ? "primary" : undefined}>
              + {t("s_aed91da")}
            </Link>
          </>
        }
      />
      {query.dupFirm === "1" ? (
        <p className="alert warn" data-testid="dup-firm">
          {t("i_signup_dup_firm")}
        </p>
      ) : null}
      {query.code === "list" ? (
        <p className="alert warn" data-testid="code-list">
          {t("i_signup_code_list")}
        </p>
      ) : null}
      {session.environment === "live" && data.properties.length === 0 ? (
        <div data-testid="dashboard-empty" data-v2-page={v2 ? "m-home" : undefined} data-v2-section={v2 ? "empty" : undefined}>
          <div className="card" style={{ textAlign: "center", padding: 36 }}>
            <h2 style={{ marginTop: 0 }}>{t("i_dash_welcome")}</h2>
            <p className="hint">{t("i_dash_steps")}</p>
          </div>
          <div className="grid3" style={{ marginTop: 16 }}>
            <div className="card" style={{ textAlign: "center" }}>
              <div className="guide-no">1</div>
              <h3>{t("i_dash_step1")}</h3>
              <p className="hint">{t("i_dash_step1_help")}</p>
            </div>
            <div className="card" style={{ textAlign: "center" }}>
              <div className="guide-no">2</div>
              <h3>{t("i_dash_step2")}</h3>
              <p className="hint">{t("i_dash_step2_help")}</p>
            </div>
            <div className="card" style={{ textAlign: "center" }}>
              <div className="guide-no">3</div>
              <h3>{t("i_dash_step3")}</h3>
              <p className="hint">{t("i_dash_step3_help")}</p>
            </div>
          </div>
          <div style={{ textAlign: "center", marginTop: 16 }}>
            <Link className="btn pri" href="/m/properties/new" data-testid="dash-first-property">
              {t("i_dash_first")}
            </Link>
            <p className="small">
              <a href="/api/env?set=sandbox&next=/m" data-testid="dash-sample">
                {t("i_dash_sample")}
              </a>
            </p>
            <p className="hint" data-testid="dash-free">{t("i_dash_free")}</p>
            <p className="hint">
              <Link href="/m/import" data-testid="dash-import">
                {t("i_dash_import")}
              </Link>
            </p>
          </div>
        </div>
      ) : null}
      {session.environment === "live" && data.properties.length === 0 ? null : (
      <>
      <div className="grid5" style={{ marginBottom: 16 }} data-v2-page={v2 ? "m-home" : undefined} data-v2-section={v2 ? "stats" : undefined}>
        <Link className="card kpi" href="/m/rent">
          <div className="lbl">{t("i_paid")}</div>
          <div className="val" data-testid="dash-received">{money(data.received)}</div>
        </Link>
        <Link className="card kpi" href="/m/rent">
          <div className="lbl">{t("i_open_balance")}</div>
          <div className="val" data-testid="dash-outstanding">{money(data.outstanding)}</div>
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
      <div className="grid2" data-v2-page={v2 ? "m-home" : undefined} data-v2-section={v2 ? "panels" : undefined}>
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
                    <b>{displaySampleName(property.name)}</b>
                    <span className="sp" />
                    <span data-testid="dash-property-amounts">{money(received)} / {money(billed)}</span>
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
            <h3>{t("i_outstanding")}</h3>
          </div>
          {data.owing.length === 0 ? (
            <div className="empty">{t("i_empty")}</div>
          ) : (
            <RfTable testId="outstanding-list">
              <thead>
                <tr>
                  <th>{t("s_74f19b0")}</th>
                  <th>{t("i_space")}</th>
                  <th>{t("i_balance")}</th>
                </tr>
              </thead>
              <tbody>
                {data.owing.map((row) => (
                  <tr key={row.lease_id} className="click">
                    <Cell>
                      <Link className="hit" href={`/m/leases/${row.lease_id}?tab=ledger`}>
                        {displaySampleName(row.tenant)}
                      </Link>
                    </Cell>
                    <Cell label={t("i_space")}>{displaySampleName(row.place)}</Cell>
                    <Cell label={t("i_balance")}>{money(row.balance, row.currency)}</Cell>
                  </tr>
                ))}
              </tbody>
            </RfTable>
          )}
        </div>
      </div>
      <div className="card" style={{ marginTop: 16 }} data-v2-page={v2 ? "m-home" : undefined} data-v2-section={v2 ? "expiring" : undefined}>
        <div className="hd">
          <h3>{t("i_expiring")}</h3>
        </div>
        {data.expiring.length === 0 ? (
          <div className="empty">{t("i_empty")}</div>
        ) : (
          <RfTable testId="expiring-list">
            <thead>
              <tr>
                <th>{t("s_74f19b0")}</th>
                <th>{t("i_space")}</th>
                <th>{t("i_end_date")}</th>
              </tr>
            </thead>
            <tbody>
              {data.expiring.map((row) => (
                <tr key={row.lease_id} className="click">
                  <Cell>
                    <Link className="hit" href={`/m/leases/${row.lease_id}`}>
                      {displaySampleName(row.tenant)}
                    </Link>
                  </Cell>
                  <Cell label={t("i_space")}>{displaySampleName(row.place)}</Cell>
                  <Cell label={t("i_end_date")}>{formatDate(row.end_date, session.locale, session.calendar, dict)}</Cell>
                </tr>
              ))}
            </tbody>
          </RfTable>
        )}
      </div>
      </>
      )}
      <FooterNote demoLine={showDemoLineCopy(session.environment)} />
    </>
  );
}
