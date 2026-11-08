/** Local simulation only: receives no address, link or token and performs no I/O.
 * The durable result row is the capture record. This is never a delivery claim.
 */
export async function portalResendMockTransport(signal: AbortSignal): Promise<"captured"> {
  if (signal.aborted) throw new Error("Simulation deadline");
  return "captured";
}
