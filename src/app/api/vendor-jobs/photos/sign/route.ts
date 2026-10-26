import { NextResponse } from "next/server";
import { FlowError } from "@/server/errors";
import { prepareVendorPhoto } from "@/server/vendor-repair";

export const dynamic = "force-dynamic";

function jsonError(error: unknown) {
  const key = error instanceof FlowError ? error.key : "errors.generic";
  const status = key === "errors.notFound" || key === "errors.forbidden" ? 404 : 400;
  return NextResponse.json({ ok: false, error: key }, { status });
}

export async function POST(request: Request) {
  try {
    const body = (await request.json()) as { token?: string; fileName?: string; mime?: string; size?: number };
    const result = await prepareVendorPhoto(String(body.token ?? ""), {
      fileName: String(body.fileName ?? ""),
      mime: String(body.mime ?? ""),
      size: Number(body.size),
    });
    return NextResponse.json({ ok: true, ...result });
  } catch (error) {
    return jsonError(error);
  }
}
