import { NextResponse } from "next/server";
import { FlowError } from "@/server/errors";
import { prepareReceiptUpload, type ReceiptKind } from "@/server/receipts";
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
    const body = (await request.json()) as { kind?: string; fileName?: string; mime?: string; size?: number };
    const kind: ReceiptKind = body.kind === "payment" ? "payment" : "expense";
    const result = await prepareReceiptUpload(session, {
      kind,
      fileName: String(body.fileName ?? ""),
      mime: String(body.mime ?? ""),
      size: Number(body.size),
    });
    return NextResponse.json({ ok: true, ...result });
  } catch (error) {
    return jsonError(error);
  }
}
