export type BankMatchBasis = {
  amountExact: boolean;
  last5Matched: boolean;
  dateDeltaDays: number | null;
};

/** Project stored scoring reasons, never live payment data or arbitrary JSON. */
export function bankMatchBasis(reasons: unknown): BankMatchBasis {
  const empty: BankMatchBasis = { amountExact: false, last5Matched: false, dateDeltaDays: null };
  if (!reasons || typeof reasons !== "object" || Array.isArray(reasons)) return empty;
  const prototype = Object.getPrototypeOf(reasons);
  if (prototype !== Object.prototype && prototype !== null) return empty;
  // JSONB has data properties. Avoid inherited values and accessors at this boundary.
  const value = (key: string): unknown => Object.getOwnPropertyDescriptor(reasons, key)?.value;
  const last5 = value("last5"), days = value("date_delta_days");
  return {
    amountExact: value("amount_exact") === true,
    last5Matched: typeof last5 === "string" && last5.length === 5 && /^[0-9]{5}$/.test(last5),
    dateDeltaDays: typeof days === "number" && Number.isSafeInteger(days) && days >= 0 ? days : null,
  };
}
