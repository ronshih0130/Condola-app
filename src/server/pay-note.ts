/** Rent is invoiced after both parties sign. Only a 待簽署 lease says so on /t/pay. */
export function unsignedRentNoteKey(status: string): "i_pay_unsigned_rent" | null {
  return status === "pending_signature" ? "i_pay_unsigned_rent" : null;
}
