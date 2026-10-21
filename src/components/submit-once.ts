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
