import { many, tx } from "./db";
import { FlowError } from "./errors";
import { monthBounds, taipeiToday } from "./money";
import { assertPerm } from "./perms";
import type { Session } from "./types";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const MONTH = /^\d{4}-\d{2}$/;

export type ReportPeriod = {
  mode: "month" | "range";
  month: string;
  start: string;
  end: string;
};

export type ReportRow = {
  property_id: string | null;
  property_name: string | null;
  owner_name: string | null;
  currency: string;
  income_minor: string;
  expense_minor: string;
  net_minor: string;
};

export type ReportLabels = {
  property: string;
  owner: string;
  currency: string;
  income: string;
  expense: string;
  net: string;
  total: string;
};

type Choice = { id: string; name: string };

export function reportPeriod(
  input: { mode?: string; month?: string; from?: string; to?: string },
  today = taipeiToday(),
): ReportPeriod {
  if (input.mode === "range") {
    const start = (input.from ?? "").trim();
    const end = (input.to ?? "").trim();
    if (!DAY.test(start) || !DAY.test(end) || end < start) throw new FlowError("errors.reportRange");
    return { mode: "range", month: start.slice(0, 7), start, end };
  }
  const month = MONTH.test(input.month ?? "") ? (input.month as string) : today.slice(0, 7);
  const bounds = monthBounds(month);
  return { mode: "month", month, start: bounds.start, end: bounds.end };
}

function csvQuote(value: string) {
  return `"${value.replaceAll('"', '""')}"`;
}

/** Stop a spreadsheet from treating a text cell as a formula. Numbers stay as entered. */
function csvText(value: string) {
  const safe = /^[=+\-@\t\r]/.test(value) ? `'${value}` : value;
  return csvQuote(safe);
}

function major(minor: string) {
  return (Number(minor) / 100).toFixed(2);
}

/** CSV from the SQL rows. Totals are the rows Postgres already returned. */
export function reportCsv(rows: ReportRow[], labels: ReportLabels) {
  const header = [labels.property, labels.owner, labels.currency, labels.income, labels.expense, labels.net]
    .map(csvText)
    .join(",");
  const lines = rows.map((row) => {
    const name = row.property_id ? (row.property_name ?? "") : labels.total;
    return [
      csvText(name),
      csvText(row.owner_name ?? ""),
      csvText(row.currency),
      csvQuote(major(row.income_minor)),
      csvQuote(major(row.expense_minor)),
      csvQuote(major(row.net_minor)),
    ].join(",");
  });
  return `\uFEFF${[header, ...lines].join("\n")}\n`;
}

function uuidOrNull(value: string | undefined) {
  const text = (value ?? "").trim();
  return UUID.test(text) ? text : null;
}

export async function reportFilterOptions(session: Session) {
  assertPerm(session, "reports.export");
  return tx(session.userId, async (client) => {
    const properties = await many<Choice>(
      client,
      `SELECT id::text, name FROM properties WHERE org_id = $1 AND archived_at IS NULL ORDER BY name`,
      [session.orgId],
    );
    const owners = await many<Choice>(
      client,
      `SELECT id::text, display_name AS name FROM contacts
        WHERE org_id = $1 AND is_owner AND archived_at IS NULL
        ORDER BY display_name`,
      [session.orgId],
    );
    return { properties, owners };
  });
}

export async function loadIncomeExpense(
  session: Session,
  input: { start: string; end: string; propertyId?: string; ownerId?: string },
) {
  assertPerm(session, "reports.export");
  const propertyId = uuidOrNull(input.propertyId);
  const ownerId = uuidOrNull(input.ownerId);
  return tx(session.userId, async (client) => {
    const rows = await many<ReportRow>(
      client,
      `SELECT property_id::text, property_name, owner_name, btrim(currency) AS currency,
              income_minor::text, expense_minor::text, net_minor::text
         FROM app.income_expense_report($1::uuid, $2::uuid, $3::uuid, $4::date, $5::date)
        ORDER BY currency, property_id NULLS LAST, property_name NULLS LAST`,
      [session.orgId, propertyId, ownerId, input.start, input.end],
    );
    return rows;
  });
}
