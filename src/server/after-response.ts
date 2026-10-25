type Waitable = { waitUntil?: (promise: Promise<unknown>) => void };
type CloudflareHolder = { ctx?: Waitable };

/**
 * Run work after the response on Workers. Node tests and `next dev` have no
 * request context, so they await the same promise and the audit row is visible
 * before the caller continues.
 */
export async function finishAfterResponse(work: Promise<unknown>) {
  const holder = (globalThis as Record<symbol, CloudflareHolder | undefined>)[Symbol.for("__cloudflare-context__")];
  const ctx = holder?.ctx;
  if (ctx && typeof ctx.waitUntil === "function") {
    ctx.waitUntil(work);
    return;
  }
  await work;
}
