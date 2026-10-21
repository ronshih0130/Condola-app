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

/**
 * Release the guard when the server action throws. A redirect throws too, so a
 * retry is not stuck; the lease idempotency key keeps that retry from inserting
 * a second row. A resolved error state keeps the guard until the form effect
 * sees the error.
 */
export async function callSubmitAction<T>(guard: { current: boolean }, run: () => Promise<T>): Promise<T> {
  let thrown = false;
  try {
    return await run();
  } catch (error) {
    thrown = true;
    throw error;
  } finally {
    if (thrown) releaseFormSubmit(guard);
  }
}

/** One key for this wizard instance. The hidden field is filled before FormData is read. */
export function ensureIdempotencyKey(holder: { current: string }) {
  if (!holder.current) holder.current = crypto.randomUUID();
  return holder.current;
}
