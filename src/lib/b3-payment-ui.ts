import { FlowError } from "../server/errors";
import type { tenantPaymentHistory } from "../server/tenant-payment-history";

/** Optional dashboard reads may be forbidden without denying the dashboard itself. */
export async function omitForbidden<T>(read: () => Promise<T>): Promise<T | undefined> {
  try {
    return await read();
  } catch (error) {
    if (error instanceof FlowError && error.key === "errors.forbidden") return undefined;
    throw error;
  }
}

/**
 * For a read that only decorates a page (the monthly figure on 今天): any failure means the
 * decoration is left out. It is never shown as zero, and it never takes the page down.
 */
export async function omitFailure<T>(read: () => Promise<T>, onError: (error: unknown) => void): Promise<T | undefined> {
  try {
    return await read();
  } catch (error) {
    if (!(error instanceof FlowError && error.key === "errors.forbidden")) onError(error);
    return undefined;
  }
}

export function currentPaymentHistoryOptions(v3: boolean, selection: { cursor?: string; reportId?: string } = {}): Parameters<typeof tenantPaymentHistory>[2] {
  return { view: "current", ...selection, ...(v3 ? { turn: true } : {}) };
}
