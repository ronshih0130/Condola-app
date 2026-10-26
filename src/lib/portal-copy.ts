/** Shown when the link exists but the clipboard refused it. */
export const PORTAL_COPY_FAILED = "i_portal_copy_failed";

/** Shown when the invite request never completed, so no link was created. */
export const PORTAL_COPY_OFFLINE = "i_portal_copy_offline";

/** Success 「已複製給…」 stays at least this long. It does not fade earlier. */
export const PORTAL_COPY_HOLD_MS = 4000;

export type PortalCopyResult = { ok: true } | { ok: false; key: typeof PORTAL_COPY_FAILED };

type PortalClipboard = {
  write?: (items: ClipboardItem[]) => Promise<void>;
  writeText?: (value: string) => Promise<void>;
};

type ClipboardItemCtor = new (items: Record<string, Blob | Promise<Blob>>) => ClipboardItem;

/** Success stays until a later action replaces it, including after the 4 second hold. */
export function portalSuccessVisible(elapsedMs: number, replaced: boolean) {
  if (replaced || !Number.isFinite(elapsedMs) || elapsedMs < 0) return false;
  return true;
}

/** The success line has been on screen for the required hold. */
export function portalSuccessHoldComplete(elapsedMs: number) {
  return elapsedMs >= PORTAL_COPY_HOLD_MS;
}

/** The failure notice stays until the user dismisses it. There is no timer. */
export function portalFailureVisible(elapsedMs: number, dismissed: boolean) {
  if (dismissed || !Number.isFinite(elapsedMs) || elapsedMs < 0) return false;
  return true;
}

const NETWORK_FAILURE =
  /failed to fetch|networkerror|network request failed|load failed|offline|internet connection appears to be offline|network connection was lost|err_internet_disconnected|fetch failed/i;

function errorText(error: unknown) {
  if (typeof error === "string") return error;
  if (error instanceof Error) return error.message;
  if (error && typeof error === "object" && "message" in error && typeof error.message === "string") return error.message;
  return "";
}

function errorName(error: unknown) {
  if (error instanceof Error) return error.name;
  if (error && typeof error === "object" && "name" in error && typeof error.name === "string") return error.name;
  return "";
}

/** A thrown server action that never reached the app. NotAllowedError is not this. */
export function isPortalNetworkError(error: unknown): boolean {
  if (errorName(error) === "NetworkError") return true;
  if (NETWORK_FAILURE.test(errorText(error))) return true;
  if (error && typeof error === "object" && "cause" in error) {
    return isPortalNetworkError((error as { cause?: unknown }).cause);
  }
  return false;
}

/**
 * Copy the invite URL. Any rejection, including NotAllowedError, is a failed
 * copy. The caller must not show the success toast in that case.
 */
export async function finishPortalCopy(
  url: string,
  writeText: (value: string) => Promise<void>,
): Promise<PortalCopyResult> {
  try {
    await writeText(url);
    return { ok: true };
  } catch {
    return { ok: false, key: PORTAL_COPY_FAILED };
  }
}

/**
 * Start the clipboard write in the same turn as the click. ClipboardItem
 * accepts a blob promise, so the browser keeps the user gesture while the
 * server is still creating the link. Browsers without ClipboardItem fall
 * back to writeText after the link arrives.
 */
export function startPortalCopy(
  link: Promise<string>,
  clipboard: PortalClipboard,
  itemCtor: ClipboardItemCtor | undefined = typeof ClipboardItem === "function" ? ClipboardItem : undefined,
): Promise<PortalCopyResult> {
  const failed: PortalCopyResult = { ok: false, key: PORTAL_COPY_FAILED };
  const write = clipboard.write?.bind(clipboard);
  if (write && itemCtor) {
    const blob = link.then((url) => new Blob([url], { type: "text/plain" }));
    void blob.catch(() => undefined);
    try {
      const item = new itemCtor({ "text/plain": blob });
      return write([item]).then(
        () => ({ ok: true }),
        () => failed,
      );
    } catch {
      // ClipboardItem rejected the payload. writeText is the unsupported path.
    }
  }
  const writeText = clipboard.writeText?.bind(clipboard);
  if (!writeText) return Promise.resolve(failed);
  return link.then((url) => writeText(url)).then(
    () => ({ ok: true }),
    () => failed,
  );
}

/** Network and offline failures use a different sentence from a clipboard refusal. */
export function portalIssueFailureKey(
  error: unknown,
  online = true,
): typeof PORTAL_COPY_FAILED | typeof PORTAL_COPY_OFFLINE {
  if (online === false || isPortalNetworkError(error)) return PORTAL_COPY_OFFLINE;
  return PORTAL_COPY_FAILED;
}
