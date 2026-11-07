import { guardEffectiveSession } from "@/server/b017-custom-role-governance";
import { can } from "@/server/perms";
import { requireCurrentConsent } from "@/server/consent-gate";
import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { SESSION_COOKIE } from "@/server/auth";
import { demoModeEnabled } from "@/server/demo";
import { resetAndSeed } from "@/server/seed";
import { readSession } from "@/server/session";

export async function POST() {
  if (!demoModeEnabled()) return new NextResponse(null, { status: 404 });
  const session = await guardEffectiveSession(await readSession(), "settings.edit");
  if (!session || (session.customRole && !can(session, "settings.edit")) || session.kind !== "staff" || session.role !== "admin") {
    return new NextResponse(null, { status: 404 });
  }
  const blocked = await requireCurrentConsent(session, "api");
  if (blocked) return blocked;
  await resetAndSeed();
  const jar = await cookies();
  jar.delete(SESSION_COOKIE);
  jar.delete("condola_persona");
  jar.delete("condola_lease");
  jar.delete("condola_tryout_hide");
  jar.delete("condola_tenant_focus");
  return NextResponse.json({ ok: true });
}
