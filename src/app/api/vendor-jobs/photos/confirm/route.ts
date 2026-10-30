import { NextResponse } from "next/server";
import { FlowError } from "@/server/errors";
import { confirmVendorPhoto } from "@/server/vendor-repair";

export const dynamic = "force-dynamic";

function jsonError(error: unknown) {
  const key = error instanceof FlowError ? error.key : "errors.generic";
  const status = key === "errors.notFound" || key === "errors.forbidden" ? 404 : 400;
  return NextResponse.json({ ok: false, error: key }, { status });
}

export async function POST(request: Request) {
  try {
    const body = (await request.json()) as {
      token?: string;
      path?: string;
      fileName?: string;
      mime?: string;
      size?: number;
      uploadToken?: string;
    };
    const id = await confirmVendorPhoto(String(body.token ?? ""), {
      path: String(body.path ?? ""),
      fileName: String(body.fileName ?? ""),
      mime: String(body.mime ?? ""),
      size: Number(body.size),
      uploadToken: String(body.uploadToken ?? ""),
    });
    return NextResponse.json({ ok: true, id });
  } catch (error) {
    return jsonError(error);
  }
}
