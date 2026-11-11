export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import { readSession } from "@/server/session";
import { handleAcceptExisting } from "@/server/unit-line-invite-api";

const INVALID_HEADERS = {
  "Cache-Control": "no-store",
  "Referrer-Policy": "no-referrer",
};

function invalid() {
  return NextResponse.json(
    { ok: false, error: "errors.invalid" },
    { status: 400, headers: INVALID_HEADERS },
  );
}

export async function POST(request: Request) {
  const session = await readSession();

  const contentType = request.headers.get("content-type") || "";
  if (!contentType.includes("application/json")) {
    return invalid();
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return invalid();
  }

  if (
    typeof body !== "object" ||
    body === null ||
    Array.isArray(body)
  ) {
    return invalid();
  }

  const ip =
    request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
    request.headers.get("x-real-ip") ||
    undefined;

  const b = body as { token?: unknown; orgId?: unknown; unitId?: unknown };
  const token = typeof b.token === "string" ? b.token : undefined;
  const orgId = typeof b.orgId === "string" ? b.orgId : undefined;
  const unitId = typeof b.unitId === "string" ? b.unitId : undefined;

  return handleAcceptExisting(session, { token, orgId, unitId }, ip);
}
