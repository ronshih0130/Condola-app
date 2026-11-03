/** Rent and electricity are billed after both parties sign. The note replaces an empty bill list. */
export function unsignedRentNoteKey(status: string, billEmpty: boolean): "i_pay_unsigned_bill" | null {
  if (status !== "pending_signature" || !billEmpty) return null;
  return "i_pay_unsigned_bill";
}

/** Preserve the prior unsigned payee audience when new residual credit rows appear. */
export function tenantPayeeVisible(status: string, billEmpty: boolean, lines?: ReadonlyArray<{chargeType:string;description:string}>): boolean {
  if (status !== "pending_signature") return true;
  if (billEmpty) return false;
  return lines === undefined || lines.some((line) => !(line.chargeType === "credit" && line.description.startsWith("沖銷電費")));
}
