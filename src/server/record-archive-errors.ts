import { FlowError } from "./errors";

/** Both codes abort the transaction; archive callers may ask for a retry. */
export function isDbContention(error: unknown): boolean {
  const metadata = error as { code?: unknown; cause?: { code?: unknown } } | null;
  const code = metadata?.code ?? metadata?.cause?.code;
  return code === "55P03" || code === "40P01";
}

/** Only the positively enabled DB admission guard emits this fixed detail.
 * Untagged errors retain the legacy mapping, with no extra flag query or retry.
 */
export function archiveWriteError(error: unknown): unknown {
  const metadata = error as { detail?: unknown; code?: unknown } | null;
  if (!isDbContention(error) || metadata?.detail !== "b015_archive_enabled_contention") return error;
  const busy = new FlowError("errors.busy");
  busy.cause = { code: metadata.code };
  return busy;
}
