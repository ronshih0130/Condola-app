import { NextResponse } from "next/server";
import { getSession } from "@/server/session";
import { writeMonthlyRent } from "@/server/monthly-rent-writer";
import { parseRequestId } from "./_request-id";

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

  let input: Parameters<typeof writeMonthlyRent>[1];
  try {
    const value: unknown = await request.json();
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new TypeError("Invalid body");
    }
    const fields = value as Record<string, unknown>;
    const requestId = parseRequestId(fields.requestId);
    if (requestId === null
      || typeof fields.leaseId !== "string" || parseRequestId(fields.leaseId) === null
      || typeof fields.month !== "string" || !/^\d{4}-(0[1-9]|1[0-2])$/.test(fields.month)
      || typeof fields.expectedDigest !== "string" || !fields.expectedDigest.trim()) {
      throw new TypeError("Invalid body");
    }
    input = {
      leaseId: fields.leaseId, month: fields.month,
      requestId, expectedDigest: fields.expectedDigest,
    };
  } catch {
    return NextResponse.json({ status: "rejected_invalid" }, { status: 400, headers });
  }

  const result = await writeMonthlyRent(session, input);
  return NextResponse.json(result, { headers });
}
