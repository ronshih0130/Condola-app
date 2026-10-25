import React, { type ReactNode } from "react";
import type { T } from "@/i18n";
import { Cell, RfTable } from "@/components/rf";

export type StatementRosterRow = {
  key: string;
  ownerName: string;
  periodLabel: string;
  units: string;
  rent: string;
  costs: string;
  net: ReactNode;
  opening: string;
  closing: string;
  status: ReactNode;
  action?: ReactNode;
};

/** The statement list on /m/statements. Opening and closing stay on the row. */
export function StatementRosterTable({
  t,
  rows,
}: {
  t: T;
  rows: StatementRosterRow[];
}) {
  return (
    <RfTable testId="statement-list">
      <thead>
        <tr>
          <th>{t("i_owner")}</th>
          <th>{t("i_stmt_units")}</th>
          <th>{t("i_opening")}</th>
          <th>{t("i_stmt_rent")}</th>
          <th>{t("i_stmt_costs")}</th>
          <th>{t("i_stmt_net")}</th>
          <th>{t("i_closing")}</th>
          <th>{t("i_status")}</th>
          <th />
        </tr>
      </thead>
      <tbody>
        {rows.map((row) => (
          <tr key={row.key}>
            <Cell>
              <b>{row.ownerName}</b>
              <div className="small muted">{row.periodLabel}</div>
            </Cell>
            <Cell label={t("i_stmt_units")}>{row.units}</Cell>
            <Cell label={t("i_opening")}>
              <span data-testid="statement-list-opening">{row.opening}</span>
            </Cell>
            <Cell label={t("i_stmt_rent")}>{row.rent}</Cell>
            <Cell label={t("i_stmt_costs")}>{row.costs}</Cell>
            <Cell label={t("i_stmt_net")}>{row.net}</Cell>
            <Cell label={t("i_closing")}>
              <span data-testid="statement-list-closing">{row.closing}</span>
            </Cell>
            <Cell label={t("i_status")}>{row.status}</Cell>
            <Cell action>{row.action}</Cell>
          </tr>
        ))}
      </tbody>
    </RfTable>
  );
}
