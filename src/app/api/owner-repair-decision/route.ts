import * as crypto from "node:crypto";
import { requireCurrentConsent } from "@/server/consent-gate";
import { getSession } from "@/server/session";
import { decideEstimate } from "@/server/repair-approval";
import { assertDecision, assertIdentifiers } from "@/server/repair-approval-rules";
import { FlowError } from "@/server/errors";

export const dynamic = "force-dynamic";
const headers = { "Cache-Control": "private, no-store", Vary: "Cookie" };

export async function POST(request: Request) {
  const denied = await requireCurrentConsent(undefined, "api");
  if (denied) return denied;
  const session = await getSession();
  if (session.kind !== "owner") return new Response(null, { status: 403, headers });
  const origin = request.headers.get("origin");
  if (origin && origin !== new URL(request.url).origin) return new Response(null, { status: 403, headers });
  if (request.headers.get("content-type")?.split(";")[0].trim() !== "application/json") {
    return new Response(null, { status: 415, headers });
  }
  let input: { versionId: string; decision: string; reason: string | null };
  try {
    const body = await request.text();
    if (body.length > 20000) return new Response(null, { status: 413, headers });
    const value: unknown = JSON.parse(body);
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new FlowError("errors.required");
    const fields = value as Record<string, unknown>;
    if (typeof fields.versionId !== "string" || typeof fields.decision !== "string"
      || (fields.reason != null && typeof fields.reason !== "string")) throw new FlowError("errors.required");
    input = { versionId: fields.versionId, decision: fields.decision, reason: fields.reason as string | null ?? null };
    assertIdentifiers(input.versionId);
    assertDecision(input);
  } catch {
    return Response.json({ status: "rejected_invalid" }, { status: 400, headers });
  }
  try {
    const result = await decideEstimate(session, { ...input, requestId: crypto.randomUUID() });
    return Response.json(result, { headers });
  } catch (error) {
    const code = (error as { code?: string }).code;
    if (code === "40001") return Response.json({ status: "rejected_conflict" }, { status: 409, headers });
    if (code === "42501") return new Response(null, { status: 403, headers });
    throw error;
  }
}
