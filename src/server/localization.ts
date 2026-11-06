import type { Client } from "pg";
import { FlowError } from "./errors";

export type DbClient = Pick<Client, "query">;

export type LocalizationContext = {
  currency: string;
  /** Storage exponent; use this to convert minor amounts to major amounts. */
  minorUnit: number;
  /** Display precision only; never use this to convert stored amounts. */
  displayDecimals: number;
  locale: string;
  timezone: string;
  jurisdictionCode: string | null;
};

type LocalizationRow = {
  property_id: string | null;
  property_currency: string | null;
  property_timezone: string | null;
  org_currency: string | null;
  org_locale: string | null;
  org_timezone: string | null;
  jurisdiction_currency: string | null;
  jurisdiction_locale: string | null;
  jurisdiction_timezone: string | null;
  jurisdiction_code: string | null;
};

function requireOrgId(orgId: string): void {
  if (typeof orgId !== "string" || !orgId.trim()) {
    throw new FlowError("errors.forbidden");
  }
}

/** Pure read. Callers must supply the org from their authorized session scope. */
export async function resolveLocalizationContext(
  db: DbClient,
  orgId: string,
  opts?: { propertyId?: string },
): Promise<LocalizationContext> {
  requireOrgId(orgId);
  const propertyId = opts?.propertyId;
  if (propertyId !== undefined && (typeof propertyId !== "string" || !propertyId.trim())) {
    throw new FlowError("errors.notFound");
  }
  // Properties have currency/timezone/jurisdiction overrides, but no locale column.
  const { rows } = await db.query<LocalizationRow>(
    `SELECT p.id AS property_id,
            p.currency AS property_currency, p.timezone AS property_timezone,
            o.default_currency AS org_currency, o.default_locale AS org_locale,
            o.timezone AS org_timezone,
            j.default_currency AS jurisdiction_currency,
            j.default_locale AS jurisdiction_locale,
            j.default_timezone AS jurisdiction_timezone,
            j.code AS jurisdiction_code
       FROM organizations o
       LEFT JOIN properties p ON p.org_id = o.id AND p.id = $2::uuid
       LEFT JOIN jurisdictions j ON j.id = COALESCE(p.jurisdiction_id, o.jurisdiction_id)
      WHERE o.id = $1::uuid`,
    [orgId, propertyId ?? null],
  );
  const row = rows[0];
  if (!row || (propertyId !== undefined && !row.property_id)) {
    throw new FlowError("errors.notFound");
  }
  const currency = row.property_currency ?? row.org_currency ?? row.jurisdiction_currency;
  const locale = row.org_locale ?? row.jurisdiction_locale;
  const timezone = row.property_timezone ?? row.org_timezone ?? row.jurisdiction_timezone;
  if (!currency || !locale || !timezone) {
    throw new FlowError("errors.generic");
  }
  const scales = await db.query<{ minor_unit: number; display_decimals: number }>(
    "SELECT minor_unit, display_decimals FROM currencies WHERE code = $1",
    [currency],
  );
  const scale = scales.rows[0];
  if (!scale) throw new FlowError("errors.generic");
  return {
    currency,
    minorUnit: scale.minor_unit,
    displayDecimals: scale.display_decimals,
    locale,
    timezone,
    jurisdictionCode: row.jurisdiction_code,
  };
}

export type JurisdictionRule = {
  value: unknown;
  enforcement: string;
  legalStatus: string;
};

/** Same precedence and [from, to) window as effective_rule; no cross-org rows. */
export async function resolveJurisdictionRule(
  db: DbClient,
  orgId: string,
  jurisdictionCode: string,
  ruleKey: string,
  on: string,
): Promise<JurisdictionRule | null> {
  requireOrgId(orgId);
  const { rows } = await db.query<JurisdictionRule>(
    `WITH RECURSIVE chain AS (
       SELECT id, parent_id, 0 AS depth, ARRAY[id] AS path
         FROM jurisdictions WHERE code = $2
       UNION ALL
       SELECT j.id, j.parent_id, c.depth + 1, c.path || j.id
         FROM jurisdictions j JOIN chain c ON j.id = c.parent_id
        WHERE NOT (j.id = ANY(c.path))
     )
     SELECT r.value, r.enforcement::text AS enforcement,
            r.legal_status::text AS "legalStatus"
       FROM jurisdiction_rules r JOIN chain c ON r.jurisdiction_id = c.id
      WHERE (r.org_id = $1::uuid OR r.org_id IS NULL)
        AND r.rule_key = $3
        AND r.effective_from <= $4::date
        AND (r.effective_to IS NULL OR r.effective_to > $4::date)
      ORDER BY (r.org_id IS NOT NULL) DESC, c.depth, r.effective_from DESC
      LIMIT 1`,
    [orgId, jurisdictionCode, ruleKey, on],
  );
  return rows[0] ?? null;
}
