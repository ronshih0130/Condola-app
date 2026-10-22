/** Rent and electricity are billed after both parties sign. The note replaces an empty bill list. */
export function unsignedRentNoteKey(status: string, billEmpty: boolean): "i_pay_unsigned_bill" | null {
  if (status !== "pending_signature" || !billEmpty) return null;
  return "i_pay_unsigned_bill";
}
