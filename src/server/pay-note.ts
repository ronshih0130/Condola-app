/** Rent and electricity are billed after both parties sign. Only a 待簽署 lease says so on /t/pay. */
export function unsignedRentNoteKey(status: string): "i_pay_unsigned_bill" | null {
  return status === "pending_signature" ? "i_pay_unsigned_bill" : null;
}
