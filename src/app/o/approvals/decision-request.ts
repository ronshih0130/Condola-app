/** Shared wire contract. Retain requestId across retries of the same decision. */
export type DecisionRequest = { requestId: string; versionId: string; decision: string; reason: string | null };
export async function postOwnerDecision(input: DecisionRequest): Promise<string | undefined> {
  const response = await fetch("/api/owner-repair-decision", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
  const result: { status?: string } = await response.json();
  return result.status;
}
