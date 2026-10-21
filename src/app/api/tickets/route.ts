import { NextResponse } from "next/server";
import { createTicket } from "@/server/domain";
import { FlowError } from "@/server/errors";
import { readSession } from "@/server/session";

export const dynamic = "force-dynamic";

function jsonError(error: unknown) {
  const key = error instanceof FlowError ? error.key : "errors.generic";
  const status = key === "errors.forbidden" ? 403 : key === "errors.notFound" ? 404 : 400;
  return NextResponse.json({ ok: false, error: key }, { status });
}

export async function POST(request: Request) {
  try {
    const session = await readSession();
    if (!session) return NextResponse.json({ ok: false, error: "errors.forbidden" }, { status: 401 });
    const body = (await request.json()) as {
      leaseId?: string;
      category?: string;
      title?: string;
      description?: string;
      returnTo?: string;
    };
    const id = await createTicket(session, {
      leaseId: String(body.leaseId ?? ""),
      category: String(body.category ?? "") || "other",
      title: String(body.title ?? ""),
      description: String(body.description ?? ""),
      priority: "normal",
    });
    const staff = body.returnTo === "staff";
    const next = staff ? `/m/tickets/${id}?created=1` : `/t/repair?done=1&id=${id}`;
    return NextResponse.json({ ok: true, id, next });
  } catch (error) {
    return jsonError(error);
  }
}
