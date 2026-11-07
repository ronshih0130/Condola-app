import { FlowError } from "./errors";
import type { LineItemCategory } from "./job-types-rules";

/** Decimal strings on the wire and in JSON; all arithmetic uses BigInt. */
export interface TradeLineInput {
  name: string;
  quantity: string;
  unit: string;
  unit_price_minor: string;
  category: LineItemCategory;
}
export interface TradeLineItem extends TradeLineInput {
  amount_minor: string;
  calculation: "quantity_half_up_v1";
}
const MAX = BigInt("9223372036854775807");
const invalid = (): never => { throw new FlowError("errors.amount"); };

export function tradeLineItems(input: unknown): TradeLineItem[] {
  if (!Array.isArray(input) || input.length < 1 || input.length > 100) return invalid();
  return input.map((value: unknown) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return invalid();
    const row = value as Record<string, unknown>;
    if (typeof row.name !== "string" || !row.name.trim() || row.name.length > 200
      || typeof row.unit !== "string" || !row.unit.trim() || row.unit.length > 24
      || /[\u0000-\u001f\u007f]/.test(row.unit + row.name)
      || typeof row.quantity !== "string" || !/^(0|[1-9][0-9]{0,11})(\.[0-9]{1,6})?$/.test(row.quantity)
      || typeof row.unit_price_minor !== "string" || !/^(0|[1-9][0-9]{0,18})$/.test(row.unit_price_minor)
      || !["service", "material", "labor"].includes(String(row.category))) return invalid();
    const [whole, fraction = ""] = row.quantity.split(".");
    const scale = BigInt(10) ** BigInt(fraction.length);
    const quantity = BigInt(whole + fraction), price = BigInt(row.unit_price_minor);
    if (quantity <= BigInt(0) || price > MAX) return invalid();
    // Nonnegative amounts: nearest minor unit, ties round up, once per line.
    const amount = (quantity * price * BigInt(2) + scale) / (scale * BigInt(2));
    if (amount <= BigInt(0) || amount > MAX) return invalid();
    return { name: row.name.trim(), quantity: row.quantity, unit: row.unit.trim(),
      unit_price_minor: price.toString(), amount_minor: amount.toString(),
      category: row.category as LineItemCategory, calculation: "quantity_half_up_v1" };
  });
}

export function tradeTotal(items: readonly TradeLineItem[]): bigint {
  const sum = tradeLineItems(items).reduce((total, row) => total + BigInt(row.amount_minor), BigInt(0));
  if (sum > MAX) return invalid();
  return sum;
}

export function isTradeLine(item: { quantity: number | string }): item is TradeLineItem {
  return typeof item.quantity === "string";
}
