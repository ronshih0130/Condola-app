import { NextResponse } from "next/server";
import { MAX_PHOTO_BYTES } from "@/lib/jpeg-size";
import { withClient } from "@/server/db";
import { FlowError } from "@/server/errors";
import { openSignedPhotoOn, storeIdPhoto } from "@/server/id-docs";
import { completeSession, readSession, readSessionOn } from "@/server/session";

export const dynamic = "force-dynamic";

const SLOTS = new Set(["front", "back", "selfie"]);

/** One photo. Encryption happens here, off the Workers CPU budget, before finalize. */
export async function POST(request: Request) {
  const session = await readSession();
  if (!session) return NextResponse.json({ error: "errors.forbidden" }, { status: 401 });
  const length = Number(request.headers.get("content-length") ?? "");
  if (Number.isFinite(length) && length > MAX_PHOTO_BYTES) return NextResponse.json({ error: "errors.idPhoto" }, { status: 413 });
  const slot = request.headers.get("x-id-slot") ?? "";
  const leaseId = request.headers.get("x-id-lease") ?? "";
  if (!SLOTS.has(slot) || !leaseId) return NextResponse.json({ error: "errors.idPhoto" }, { status: 400 });
  const bytes = new Uint8Array(await request.arrayBuffer());
  if (bytes.byteLength === 0 || bytes.byteLength > MAX_PHOTO_BYTES) {
    return NextResponse.json({ error: "errors.idPhoto" }, { status: 413 });
  }
  try {
    await storeIdPhoto(session, {
      leaseId,
      slot,
      mime: request.headers.get("content-type") ?? "",
      bytes,
    });
    return NextResponse.json({ ok: true });
  } catch (error) {
    const key = error instanceof FlowError ? error.key : "errors.generic";
    const status = key === "errors.forbidden" ? 403 : key === "errors.notFound" ? 404 : 400;
    return NextResponse.json({ error: key }, { status });
  }
}

export async function GET(request: Request) {
  const token = new URL(request.url).searchParams.get("token") ?? "";
  // One connection for the session check and the photo. touch:false avoids
  // three parallel GETs queueing on the same last_active row. The ciphertext
  // for this slot comes back in one result (24KiB rows). No server re-encode:
  // Workers Free allows 10ms of CPU, which cannot decode and re-encode a
  // capped JPEG, and this route adds no paid image dependency. The browser
  // burns the CJK lines and a red bar into the pixels, then writes a
  // condola-id-wm COM marker. Upload refuses a JPEG without that marker.
  // These bytes are that burned scan after APP/COM segments are stripped.
  // A client can forge the marker without burning pixels. A real server
  // re-encode needs a Worker with a higher cpu_ms limit.
  const photo = await withClient(async (client) => {
    const loaded = await readSessionOn(client, { touch: false });
    const session = await completeSession(loaded);
    if (!session) return null;
    try {
      return await openSignedPhotoOn(client, session, token);
    } catch {
      return null;
    }
  });
  if (!photo) return new NextResponse(null, { status: 404 });
  return new NextResponse(new Uint8Array(photo.bytes), {
    headers: {
      "content-type": photo.mime,
      "cache-control": "private, no-store",
      "x-content-type-options": "nosniff",
    },
  });
}
