import { guardEffectiveSession } from "@/server/b017-custom-role-governance";
import { requireCurrentConsent } from "@/server/consent-gate";
import { NextResponse } from "next/server";
import { FlowError, logServerError } from "@/server/errors";
import { abandonIdUpload, finalizeTenantId } from "@/server/id-docs";
import { readSession } from "@/server/session";

export const dynamic = "force-dynamic";

function asText(value: unknown) {
  return typeof value === "string" ? value : "";
}

/**
 * One document per submit. The browser posts here instead of a server action:
 * a Workers CPU kill during the action flight was returning a non-JSON error
 * and leaving the staged photos behind.
 */
export async function POST(request: Request) {
  const session = await guardEffectiveSession(await readSession(), "leases.edit");
  if (!session) return NextResponse.json({ error: "errors.forbidden" }, { status: 401 });
  const blocked = await requireCurrentConsent(session, "api");
  if (blocked) return blocked;
  let body: { leaseId?: unknown; docType?: unknown; number?: unknown; consent?: unknown };
  try {
    body = (await request.json()) as typeof body;
  } catch (error) {
    logServerError("finalizeIdRoute", error);
    return NextResponse.json({ error: "errors.generic" }, { status: 400 });
  }
  try {
    await finalizeTenantId(session, {
      leaseId: asText(body.leaseId),
      docType: asText(body.docType),
      number: asText(body.number),
      consent: body.consent === true,
    });
    return NextResponse.json({ ok: true });
  } catch (error) {
    const key = error instanceof FlowError ? error.key : "errors.generic";
    if (!(error instanceof FlowError)) logServerError("finalizeIdRoute", error);
    const status = key === "errors.forbidden" ? 403 : key === "errors.notFound" ? 404 : 400;
    return NextResponse.json({ error: key }, { status });
  }
}

/** Drop staged photos when a submit stops before the document row exists. */
export async function DELETE(request: Request) {
  const session = await guardEffectiveSession(await readSession(), "leases.edit");
  if (!session) return NextResponse.json({ error: "errors.forbidden" }, { status: 401 });
  const blocked = await requireCurrentConsent(session, "api");
  if (blocked) return blocked;
  const leaseId = request.headers.get("x-id-lease") ?? "";
  if (!leaseId) return NextResponse.json({ error: "errors.generic" }, { status: 400 });
  try {
    await abandonIdUpload(session, leaseId);
    return NextResponse.json({ ok: true });
  } catch (error) {
    const key = error instanceof FlowError ? error.key : "errors.generic";
    if (!(error instanceof FlowError)) logServerError("abandonIdRoute", error);
    const status = key === "errors.forbidden" ? 403 : 400;
    return NextResponse.json({ error: key }, { status });
  }
}
