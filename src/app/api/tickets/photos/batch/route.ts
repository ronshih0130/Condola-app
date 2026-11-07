import { requireCurrentConsent } from "@/server/consent-gate";
import { NextResponse } from "next/server";
import { readSession } from "@/server/session";
import { handleUploadBatch } from "@/server/upload-recovery-route";

export const dynamic = "force-dynamic";

// B-031 UPLOAD_RECOVERY. No session: 401. Consent gate as on every route. Then
// handleUploadBatch: one flag read, 404 when OFF (no other SQL, no writes).
export async function POST(request: Request) {
  try {
    const session = await readSession();
    if (!session) return NextResponse.json({ ok: false, error: "errors.forbidden" }, { status: 401 });
    const blocked = await requireCurrentConsent(session, "api");
    if (blocked) return blocked;
    return await handleUploadBatch(request, session);
  } catch {
    return NextResponse.json({ ok: false, error: "errors.generic" }, { status: 400 });
  }
}
