import { guardEffectiveSession } from "@/server/b017-custom-role-governance";
import { can } from "@/server/perms";
import { FlowError } from "@/server/errors";
import { requireCurrentConsent } from "@/server/consent-gate";
import { NextResponse } from "next/server";
import { getSession } from "@/server/session";
import { writeMonthlyRent } from "@/server/monthly-rent-writer";
import { sameOriginMutation } from "@/server/request-origin";
import { parseRequestId } from "./_request-id";
import { monthlyRentHttpStatus } from "./_http-status";

export const dynamic = "force-dynamic";
const headers = { "Cache-Control": "private, no-store", Vary: "Cookie" };

export async function POST(request: Request) {
  let session: Awaited<ReturnType<typeof getSession>>;
  try {
    session = await getSession();
  } catch {
    return new Response(null, { status: 401, headers });
  }
  if (!session) return new Response(null, { status: 401, headers });
  if (session.kind !== "staff") return new Response(null, { status: 403, headers });
  const denied = await requireCurrentConsent(session, "api");
  if (denied) return denied;
  if (!can(session, "stmt.generate")) {
    return new Response(null, { status: 403, headers });
  }

  if (!sameOriginMutation(request)) return new Response(null, { status: 403, headers });
  if (request.headers.get("content-type")?.split(";")[0].trim().toLowerCase() !== "application/json") {
    return new Response(null, { status: 415, headers });
  }

  let input: Parameters<typeof writeMonthlyRent>[1];
  try {
    const body = await request.text();
    if (body.length > 20000) return new Response(null, { status: 413, headers });
    const value: unknown = JSON.parse(body);
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new TypeError("Invalid body");
    }
    const fields = value as Record<string, unknown>;
    const requestId = parseRequestId(fields.requestId);
    if (requestId === null
      || typeof fields.leaseId !== "string" || parseRequestId(fields.leaseId) === null
      || typeof fields.month !== "string" || !/^\d{4}-(0[1-9]|1[0-2])$/.test(fields.month)
      || typeof fields.expectedDigest !== "string" || !/^[0-9a-f]{64}$/.test(fields.expectedDigest)) {
      throw new TypeError("Invalid body");
    }
    input = {
      leaseId: fields.leaseId, month: fields.month,
      requestId, expectedDigest: fields.expectedDigest,
    };
  } catch {
    return NextResponse.json({ status: "rejected_invalid" }, { status: 400, headers });
  }

  try {
    session = await guardEffectiveSession(session, "stmt.generate");
    const result = await writeMonthlyRent(session, input);
    return NextResponse.json(result, { status: monthlyRentHttpStatus(result.status), headers });
  } catch (error) {
    const code = error !== null && typeof error === "object" && "code" in error
      ? error.code
      : undefined;
    if (code === "40001") {
      return NextResponse.json({ status: "rejected_conflict" }, { status: 409, headers });
    }
    if (code === "42501" || (error instanceof FlowError && error.key === "errors.forbidden")) {
      return new Response(null, { status: 403, headers });
    }
    throw error;
  }
}
