import { guardEffectiveSession } from "@/server/b017-custom-role-governance";
import { requireCurrentConsent } from "@/server/consent-gate";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { ENV_COOKIE, ORG_COOKIE } from "@/server/org-scope";
import { appCookieOptions, sameAppPath } from "@/server/public-origin";
import { ensureSandbox, liveModeEnabled } from "@/server/sandbox";
import { readSession } from "@/server/session";

function safeNext(value: string | null) {
  return sameAppPath(value) || "/m";
}

export async function GET(request: Request) {
  const session = await guardEffectiveSession(await readSession(), null);
  if (!session || session.kind !== "staff") redirect("/login");
  const blocked = await requireCurrentConsent(session, "api");
  if (blocked) return blocked;
  const url = new URL(request.url);
  const set = url.searchParams.get("set");
  const next = safeNext(url.searchParams.get("next"));
  if (set !== "sandbox" && set !== "live") redirect("/m");
  const jar = await cookies();
  const sessionCookie = appCookieOptions({ httpOnly: false });
  if (set === "live" && !(await liveModeEnabled(session.liveOrgId))) {
    await ensureSandbox(session);
    jar.set(ENV_COOKIE, "sandbox", sessionCookie);
    jar.set(ORG_COOKIE, session.liveOrgId, sessionCookie);
    redirect("/m");
  }
  if (set === "sandbox") await ensureSandbox(session);
  jar.set(ENV_COOKIE, set, sessionCookie);
  jar.set(ORG_COOKIE, session.liveOrgId, sessionCookie);
  redirect(next);
}
