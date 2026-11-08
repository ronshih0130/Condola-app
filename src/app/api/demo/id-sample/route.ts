import { guardEffectiveSession } from "@/server/b017-custom-role-governance";
import { can } from "@/server/perms";
import { requireCurrentConsent } from "@/server/consent-gate";
import { NextResponse } from "next/server";
import { demoModeEnabled } from "@/server/demo";
import { attachSampleId } from "@/server/id-docs";
import { readSession } from "@/server/session";

export const dynamic = "force-dynamic";

/** Demo only: attach a masked sample ID so a try-out lease can be signed. */
export async function POST(request: Request) {
  if (!demoModeEnabled()) return new NextResponse(null, { status: 404 });
  const session = await guardEffectiveSession(await readSession(), "leases.edit");
  if (!session || (session.customRole && !can(session, "props.edit")) || session.kind !== "staff" || (session.role !== "admin" && session.role !== "manager")) {
    return new NextResponse(null, { status: 404 });
  }
  const blocked = await requireCurrentConsent(session, "api");
  if (blocked) return blocked;
  const body = (await request.json().catch(() => null)) as { leaseId?: string } | null;
  if (!body?.leaseId) return NextResponse.json({ error: "errors.required" }, { status: 400 });
  await attachSampleId(session.userId, body.leaseId);
  return NextResponse.json({ ok: true });
}
