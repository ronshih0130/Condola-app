import { monthlyBillingAvailable } from "@/server/monthly-billing-plan";
import { monthlyBillingCopy } from "@/i18n/monthly-billing-preview";
import { requireCurrentConsent } from "@/server/consent-gate";
import { Fragment } from "react";
import Link from "next/link";
import { makeT } from "@/i18n";
import { Cell, RfTable } from "@/components/rf";
import { PageHeader } from "@/components/ui";
import { moneyLabel } from "@/server/format";
import { taipeiToday } from "@/server/money";
import { rentRoll } from "@/server/queries";
import { manualRemindersEnabled } from "@/server/manual-reminders";
import { displaySampleName } from "@/server/sandbox-data";
import { getSession } from "@/server/session";

export const dynamic = "force-dynamic";

function daysBetween(due: string, today: string) {
  const start = Date.parse(`${due.slice(0, 10)}T00:00:00Z`);
  const end = Date.parse(`${today}T00:00:00Z`);
  return Math.round((end - start) / 86_400_000);
}

export default async function RentPage() {
  await requireCurrentConsent(undefined, "page");
  const session = await getSession();
  const t = makeT(session.locale);
  const [rows, remindersEnabled, monthlyAvailable] = await Promise.all([rentRoll(session), manualRemindersEnabled(session), monthlyBillingAvailable(session)]);
  const today = taipeiToday();
  let lastProperty = "";
  return (
    <>
      <PageHeader
        title={t("i_rentroll_title")}
        actions={
          <>
          {monthlyAvailable && <Link className="btn" href="/m/rent/monthly-preview">{monthlyBillingCopy(session.locale).title}</Link>}
          <Link className="btn" href="/m/rent/utilities" data-testid="utility-entry">
            {t("i_utility_open")}
          </Link>
          </>
        }
      />
      <div className="card">
        <RfTable testId="rent-roll">
          <thead>
            <tr>
              <th>{t("i_room")}</th>
              <th>{t("s_74f19b0")}</th>
              <th>{t("i_rent_label")}</th>
              <th>{t("i_due_this")}</th>
              <th>{t("i_paid")}</th>
              <th>{t("i_balance")}</th>
              <th>{t("i_status")}</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => {
              const group =
                row.property_id !== lastProperty ? (
                  <tr className="grp" key={`${row.property_id}-grp`}>
                    <td colSpan={8}>
                      {displaySampleName(row.property_name)}
                      {row.owner_name ? ` · ${row.owner_name}` : ""}
                    </td>
                  </tr>
                ) : null;
              lastProperty = row.property_id;
              const money = (minor: string | null) => moneyLabel(Number(minor ?? 0), row.currency, session.locale);
              if (!row.lease_id) {
                return (
                  <Fragment key={row.space_id}>
                    {group}
                    <tr>
                      <Cell>
                        {row.space_label} <span className="chip">{t("i_vacant")}</span>
                      </Cell>
                    </tr>
                  </Fragment>
                );
              }
              const balance = Number(row.balance);
              const due = Number(row.due);
              const received = Number(row.received);
              let status = t("i_unpaid");
              let chip = "bad";
              if (balance <= 0 && (received > 0 || due > 0)) {
                status = t("i_paid_up");
                chip = "ok";
              } else if (row.reported && balance > 0) {
                status = t("i_tenant_reported");
                chip = "warn";
              } else if (balance > 0 && row.due_date && row.due_date.slice(0, 10) > today) {
                status = t("i_not_due");
                chip = "info";
              } else if (balance > 0 && row.due_date && row.due_date.slice(0, 10) < today) {
                status = t("i_overdue_days", { days: daysBetween(row.due_date, today) });
                chip = "bad";
              } else if (due === 0 && received === 0) {
                status = t("i_not_due");
                chip = "info";
              }
              return (
                <Fragment key={row.space_id}>
                  {group}
                  <tr>
                    <Cell>{row.space_label}</Cell>
                    <Cell label={t("s_74f19b0")}>{displaySampleName(row.tenant || "")}</Cell>
                    <Cell label={t("i_rent_label")}>{money(row.rent)}</Cell>
                    <Cell label={t("i_due_this")}>{money(row.due)}</Cell>
                    <Cell label={t("i_paid")}>{money(row.received)}</Cell>
                    <Cell label={t("i_balance")}>{money(row.balance)}</Cell>
                    <Cell label={t("i_status")}>
                      <span className={`chip ${chip}`}>{status}</span>
                    </Cell>
                    <Cell action>
                      {balance > 0 ? (
                        <Link className="btn" href={remindersEnabled && row.lease_id ? `/m/rent/remind/${row.lease_id}` : "/m/notify"} data-testid="send-reminder">
                          {t("i_send_reminder")}
                        </Link>
                      ) : null}
                    </Cell>
                  </tr>
                </Fragment>
              );
            })}
          </tbody>
        </RfTable>
      </div>
    </>
  );
}
