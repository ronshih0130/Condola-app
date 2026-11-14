import React from "react";
import Link from "next/link";
import { dictionary, makeT, translate } from "@/i18n";
import { brandV3Copy } from "@/i18n/lanes/brand-v3";
import { ConfirmedBills, PaymentTurnGroups, type BillRow } from "./v3/payment-turns";
import type { StaffPaymentTurns } from "@/server/b3-payment-turns";
import { OnboardingProgress } from "./onboarding-progress";
import { EmptyState } from "./empty-state";
import { FooterNote } from "./chrome";
import { Cell, RfTable } from "./rf";
import { PageHeader } from "./ui";
import { EMPTY_ACTIONS, emptyActionAllowed, type EmptyCta } from "@/lib/empty-cta";
import { showDemoLineCopy } from "@/server/demo";
import { formatDate, moneyLabel } from "@/server/format";
import type { dashboard } from "@/server/queries";
import type { SetupProgress } from "@/server/onboarding-progress";
import type { Session } from "@/server/types";
import { displaySampleName } from "@/server/sandbox-data";

export function DashboardContent({ session, data, setup, cta, query, v2, notificationEntry, v3 = false, turns, bills, month }: {
  session: Session; data: Awaited<ReturnType<typeof dashboard>>; setup: SetupProgress; cta: EmptyCta;
  query: { dupFirm?: string; code?: string }; v2: boolean; notificationEntry?: React.ReactNode;
  v3?: boolean; turns?: StaffPaymentTurns; bills?: BillRow[]; month?: number;
}) {
  const t = makeT(session.locale);
  const dict = dictionary(session.locale);
  const money = (minor: number | string, currency = "TWD") => moneyLabel(minor, currency, session.locale);
  const paymentV3 = v3 && setup.hasUnits && turns?.state !== "off";
  return (
    <>
      <PageHeader title={paymentV3 && turns?.state === "ready" && turns.yourTurn >= 1
        ? (session.name?.trim()
            ? translate(brandV3Copy(session.locale), "todayTurns", { name: session.name, count: turns.yourTurn })
            : translate(brandV3Copy(session.locale), "todayTurnsNoName", { count: turns.yourTurn }))
        : t("i_morning", { name: session.name })} />
      <OnboardingProgress progress={setup} locale={session.locale} cta={cta} />
      {notificationEntry}
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
      {!setup.hasUnits ? <div data-testid="dashboard-empty"><EmptyState id="DASH" locale={session.locale} cta={cta} /></div> : (
      <>
      {paymentV3 && turns && <PaymentTurnGroups turns={turns} locale={session.locale} />}
      {paymentV3 && bills && month !== undefined && <ConfirmedBills rows={bills} month={month} locale={session.locale} />}
      <div className="grid5" style={{ marginBottom: 16 }} data-v2-page={v2 ? "m-home" : undefined} data-v2-section={v2 ? "stats" : undefined}>
        {!(paymentV3 && bills) && Number(data.received) > 0 ? (
        <Link className="card kpi" href="/m/rent">
          <div className="lbl">{t("i_paid")}</div>
          <div className="val" data-testid="dash-received">{money(data.received)}</div>
        </Link>
        ) : null}
        {Number(data.outstanding) > 0 ? (
        <Link className="card kpi" href="/m/rent">
          <div className="lbl">{t("i_open_balance")}</div>
          <div className="val" data-testid="dash-outstanding">{money(data.outstanding)}</div>
          <div className="sub">{t("i_tenant_count", { count: data.owingCount })}</div>
        </Link>
        ) : null}
        {!(paymentV3 && turns?.state === "ready") && data.pending > 0 ? (
        <Link className="card kpi" href="/m/payments">
          <div className="lbl">{t("i_pending_pay")}</div>
          <div className="val">{data.pending}</div>
        </Link>
        ) : null}
        {data.tickets > 0 ? (
        <Link className="card kpi" href="/m/tickets">
          <div className="lbl">{t("i_nav_tickets")}</div>
          <div className="val">{data.tickets}</div>
        </Link>
        ) : null}
        {data.occupied > 0 ? (
        <Link className="card kpi" href="/m/leases">
          <div className="lbl">{t("i_occ")}</div>
          <div className="val">
            {data.occupied}/{data.rooms}
          </div>
        </Link>
        ) : null}
      </div>
      <div className="grid2" data-v2-page={v2 ? "m-home" : undefined} data-v2-section={v2 ? "panels" : undefined}>
        {data.properties.some(property => Number(property.billed) || Number(property.received)) ? (
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
                    {received || billed ? <span data-testid="dash-property-amounts">{received ? money(received) : "—"} / {billed ? money(billed) : "—"}</span> : null}
                  </div>
                  <div className="bar">
                    <i style={{ width: `${width}%` }} />
                  </div>
                </div>
              );
            })}
          </div>
        </div>
        ) : null}
        <div className="card">
          <div className="hd">
            <h3>{t("i_outstanding")}</h3>
          </div>
          {data.owing.length === 0 ? (
            <EmptyState id={setup.step === 4 || setup.tenantJoined ? "DASH_C_pay" : "DASH_pay"} locale={session.locale} compact
              cta={{ primary: null, showAdminHint: false, links: (setup.step === 4 || setup.tenantJoined) && emptyActionAllowed(EMPTY_ACTIONS.rent, setup, key => setup.permissions.includes(key)) ? [EMPTY_ACTIONS.rent] : [] }} />
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
      <div className="card" data-v2-page={v2 ? "m-home" : undefined} data-v2-section={v2 ? "expiring" : undefined}>
        <div className="hd">
          <h3>{t("i_expiring")}</h3>
        </div>
        {data.expiring.length === 0 ? (
          <EmptyState id={setup.step === 4 || setup.tenantJoined ? "DASH_C_lease" : "DASH_lease"} locale={session.locale} compact
            cta={{ primary: null, showAdminHint: false, links: (setup.step === 4 || setup.tenantJoined) && emptyActionAllowed(EMPTY_ACTIONS.leases, setup, key => setup.permissions.includes(key)) ? [EMPTY_ACTIONS.leases] : [] }} />
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
      </div>
      </>
      )}
      <FooterNote demoLine={showDemoLineCopy(session.environment)} />
    </>
  );
}
