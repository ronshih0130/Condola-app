export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import { readSession } from "@/server/session";
import {
  handleStaffLive,
  handleStaffIssue,
  handleStaffRotate,
} from "@/server/unit-line-invite-api";

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

export async function GET(
  _request: Request,
  context: { params: Promise<{ unitId: string }> },
) {
  const session = await readSession();
  const { unitId } = await context.params;
  return handleStaffLive(session, unitId);
}

export async function POST(
  request: Request,
  context: { params: Promise<{ unitId: string }> },
) {
  const session = await readSession();
  const { unitId } = await context.params;

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

  const action = (body as { action?: unknown }).action;
  if (action === "rotate") return handleStaffRotate(session, unitId);
  if (action === "issue") return handleStaffIssue(session, unitId);
  return invalid();
}
