/**
 * Synchronous submit guard. useFormStatus and useActionState's pending flag
 * flip only after a render, so a second click in the same turn can dispatch
 * another server action. That second action races the redirect from
 * 「建立租約並送出簽署」 and surfaces as an intermittent client exception.
 */
export function claimFormSubmit(guard: { current: boolean }) {
  if (guard.current) return false;
  guard.current = true;
  return true;
}

export function releaseFormSubmit(guard: { current: boolean }) {
  guard.current = false;
}

/** Next redirect() rejects the action so the router can navigate. Anything else stays on the form. */
export function isNextRedirect(error: unknown) {
  return (
    typeof error === "object" &&
    error !== null &&
    "digest" in error &&
    typeof (error as { digest?: unknown }).digest === "string" &&
    (error as { digest: string }).digest.startsWith("NEXT_REDIRECT")
  );
}

/**
 * Network errors and other non-redirect throws become onFailure, so the wizard
 * stays mounted with the same idempotency key. The guard is released either way
 * a throw happens, and a resolved result keeps it claimed until the form effect
 * sees an error state. Redirect errors are rethrown for the Next router.
 */
export async function callSubmitAction<T>(guard: { current: boolean }, run: () => Promise<T>, onFailure: () => T): Promise<T> {
  try {
    return await run();
  } catch (error) {
    releaseFormSubmit(guard);
    if (isNextRedirect(error)) throw error;
    return onFailure();
  }
}

/** One key for this wizard instance. The hidden field is filled before FormData is read. */
export function ensureIdempotencyKey(holder: { current: string }) {
  if (!holder.current) holder.current = crypto.randomUUID();
  return holder.current;
}

/**
 * A second onSubmit for the same click must not preventDefault. That cancel
 * drops the first action's error, so the button only looks idle until the
 * next click. A later click while the guard is held is a real duplicate.
 */
export function duplicateSubmitAction(guardHeld: boolean, sameEvent: boolean) {
  if (sameEvent) return "continue" as const;
  if (guardHeld) return "block" as const;
  return "start" as const;
}

/**
 * React can deliver a second submit event for one click, with a different
 * Event object. preventDefault on that echo cancels the action that was
 * just claimed, so the button re-enables and the save looks like it failed.
 */
export function submitEcho(guardHeld: boolean, claimedAt: number, now = Date.now(), windowMs = 80) {
  return guardHeld && claimedAt > 0 && now - claimedAt < windowMs;
}

export function revealFormAlert(node: {
  scrollIntoView: (options?: ScrollIntoViewOptions) => void;
  focus: (options?: FocusOptions) => void;
  tabIndex: number;
}) {
  node.tabIndex = -1;
  node.scrollIntoView({ block: "center" });
  node.focus({ preventScroll: true });
}

/**
 * Enter commits a select, a textarea newline, and the real submit button.
 * Cancelling it on a select drops the first unit choice, so 下一步 stays disabled.
 */
export function enterCommitsControl(target: unknown) {
  if (!target || typeof target !== "object" || !("tagName" in target)) return false;
  const tag = String((target as { tagName?: string }).tagName || "").toUpperCase();
  if (tag === "TEXTAREA" || tag === "SELECT" || tag === "OPTION") return true;
  if (tag === "BUTTON") return (target as { type?: string }).type === "submit";
  return false;
}
