import { NextResponse } from "next/server";
import { confirmVendorCasePhoto } from "@/server/b105-vendor-case";
import { FlowError } from "@/server/errors";

export const dynamic = "force-dynamic";

/** B-105 RV-PHOTOS: confirm one upload into the 處理前 or 處理後 set of an accepted, open case. */
export async function POST(request: Request) {
  const origin = request.headers.get("origin");
  if (origin && origin !== new URL(request.url).origin) return NextResponse.json({ ok: false, error: "errors.forbidden" }, { status: 403 });
  try {
    const body = (await request.json()) as { token?: string; phase?: string; path?: string; fileName?: string; mime?: string; size?: number; uploadToken?: string };
    if (body.phase !== "before" && body.phase !== "after") throw new FlowError("errors.required");
    const id = await confirmVendorCasePhoto(String(body.token ?? ""), body.phase, {
      path: String(body.path ?? ""), fileName: String(body.fileName ?? ""), mime: String(body.mime ?? ""),
      size: Number(body.size), uploadToken: String(body.uploadToken ?? ""),
    });
    return NextResponse.json({ ok: true, id });
  } catch (error) {
    const key = error instanceof FlowError ? error.key : "errors.generic";
    const status = key === "errors.notFound" || key === "errors.forbidden" ? 404 : 400;
    return NextResponse.json({ ok: false, error: key }, { status });
  }
}
