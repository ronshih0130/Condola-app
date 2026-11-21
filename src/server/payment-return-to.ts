/** Exact local payment destinations only; never decode or normalize untrusted input. */
export function paymentReturnTo(value: unknown): string {
  return typeof value === "string" && /^\/m\/(payments|rent)(\/list)?(\?month=\d{4}-\d{2}&tab=(all|yours|overdue|future|paid))?$/.test(value)
    && !/[\r\n]/.test(value) ? value : "/m/payments";
}
