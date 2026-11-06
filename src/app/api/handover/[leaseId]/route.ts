import { guardEffectiveSession } from "@/server/b017-custom-role-governance";
import { requireCurrentConsent } from "@/server/consent-gate";
import { getSession } from "@/server/session";
import { discardHandoverUpload, finalizeHandoverUpload, prepareHandoverUpload, uploadHandoverBytes } from "@/server/handover";
import { readHandoverJson } from "@/server/handover-input";
import { HANDOVER_MAX_BYTES } from "@/server/handover-storage";

export const dynamic = "force-dynamic";
const headers = { "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff" };
const denied = () => Response.json({ ok: false }, { status: 404, headers });
export async function POST(request: Request, context: { params: Promise<{ leaseId: string }> }) {
  const blocked = await requireCurrentConsent(undefined, "api");
  if (blocked) return blocked;
  const session = await guardEffectiveSession(await getSession(), "leases.edit");
  const { leaseId } = await context.params;
  try {
    const body = await readHandoverJson(request);
    if (body.operation === "prepare" && typeof body.versionId === "string" && typeof body.fileName === "string" && typeof body.mime === "string" && typeof body.size === "number") {
      return Response.json({ ok: true, ...(await prepareHandoverUpload(session, leaseId, body.versionId, { fileName: body.fileName, mime: body.mime, size: body.size })) }, { headers });
    }
    if (typeof body.intentId !== "string") return denied();
    if (body.operation === "finalize") return Response.json({ ok: true, attachment: await finalizeHandoverUpload(session, leaseId, body.intentId) }, { headers });
    if (body.operation === "discard") { await discardHandoverUpload(session, leaseId, body.intentId); return Response.json({ ok: true }, { headers }); }
    return denied();
  } catch { return denied(); }
}
export async function PUT(request: Request, context: { params: Promise<{ leaseId: string }> }) {
  const blocked = await requireCurrentConsent(undefined, "api");
  if (blocked) return blocked;
  const session = await guardEffectiveSession(await getSession(), "leases.edit");
  const { leaseId } = await context.params;
  try {
    const intent = new URL(request.url).searchParams.get("intent") ?? "";
    const declared = Number(request.headers.get("content-length"));
    if (!Number.isInteger(declared) || declared < 1 || declared > HANDOVER_MAX_BYTES || !request.body) return denied();
    const reader = request.body.getReader(); const chunks: Uint8Array[] = []; let size = 0;
    try {
      while (true) { const part = await reader.read(); if (part.done) break; size += part.value.length; if (size > HANDOVER_MAX_BYTES || size > declared) return denied(); chunks.push(part.value); }
    } finally { await reader.cancel().catch(() => undefined); }
    if (size !== declared) return denied();
    await uploadHandoverBytes(session, leaseId, intent, new Uint8Array(Buffer.concat(chunks, size)));
    return Response.json({ ok: true }, { headers });
  } catch { return denied(); }
}
