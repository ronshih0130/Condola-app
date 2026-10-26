import { ConsentRequiredError, consentRequiredResponse, requireCurrentConsent } from "@/server/consent-gate";
import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { MAX_PHOTO_BYTES } from "@/lib/jpeg-size";
import { SESSION_COOKIE } from "@/server/auth";
import { FlowError } from "@/server/errors";
import { serveSignedPhoto, storeIdPhoto } from "@/server/id-docs";
import { readPhotoToken } from "@/server/id-crypto";
import { ENV_COOKIE, ORG_COOKIE } from "@/server/org-scope";
import { readSession, readSessionOn, sessionTokenHash } from "@/server/session";

export const dynamic = "force-dynamic";

const SLOTS = new Set(["front", "back", "selfie"]);

/** One photo. Encryption happens here, off the Workers CPU budget, before finalize. */
export async function POST(request: Request) {
  const session = await readSession();
  if (!session) return NextResponse.json({ error: "errors.forbidden" }, { status: 401 });
  const blocked = await requireCurrentConsent(session, "api");
  if (blocked) return blocked;
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
  // Missing cookie or a bad signature never opens a connection. Consent is
  // checked before id_photo_open. The response is the upload-time watermarked copy.
  // GET decrypts that object. A row with no copy is burned once and stored;
  // the original is never the response. Viewer and Taiwan time stay on screen.
  if (!token) return new NextResponse(null, { status: 404 });
  const jar = await cookies();
  const sessionCookie = jar.get(SESSION_COOKIE)?.value;
  if (!sessionCookie) return new NextResponse(null, { status: 404 });
  const parsed = readPhotoToken(token);
  if (!parsed) return new NextResponse(null, { status: 404 });
  const rawEnv = jar.get(ENV_COOKIE)?.value;
  let photo;
  try {
    photo = await serveSignedPhoto({
      tokenHash: sessionTokenHash(sessionCookie),
      userId: parsed.u,
      documentId: parsed.d,
      slot: parsed.s,
      preferredOrg: jar.get(ORG_COOKIE)?.value ?? null,
      env: rawEnv === "sandbox" || rawEnv === "live" ? rawEnv : null,
    }, async (client) => {
      const { session } = await readSessionOn(client, { touch: false });
      if (!session || session.userId !== parsed.u) throw new Error("Invalid photo session");
      if (await requireCurrentConsent(session, "api")) throw new ConsentRequiredError();
    });
  } catch (error) {
    if (error instanceof ConsentRequiredError) return consentRequiredResponse();
    return new NextResponse(null, { status: 404 });
  }
  if (!photo) return new NextResponse(null, { status: 404 });
  return new NextResponse(new Uint8Array(photo.bytes), {
    headers: {
      "content-type": photo.mime,
      "cache-control": "private, no-store",
      "x-content-type-options": "nosniff",
      "server-timing": `db;dur=${photo.timing.db.toFixed(1)}, decrypt;dur=${photo.timing.decrypt.toFixed(1)}, watermark;dur=${photo.timing.watermark.toFixed(1)}, total;dur=${photo.timing.total.toFixed(1)}`,
    },
  });
}
