import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { ENV_COOKIE, ENV_COOKIE_MAX_AGE, ORG_COOKIE } from "@/server/org-scope";
import { appCookieOptions, sameAppPath } from "@/server/public-origin";
import { ensureSandbox, liveModeEnabled } from "@/server/sandbox";
import { readSession } from "@/server/session";

function safeNext(value: string | null) {
  return sameAppPath(value) || "/m";
}

export async function GET(request: Request) {
  const session = await readSession();
  if (!session || session.kind !== "staff") redirect("/login");
  const url = new URL(request.url);
  const set = url.searchParams.get("set");
  const next = safeNext(url.searchParams.get("next"));
  if (set !== "sandbox" && set !== "live") redirect("/m");
  const jar = await cookies();
  const persisted = appCookieOptions({ httpOnly: false, maxAge: ENV_COOKIE_MAX_AGE });
  if (set === "live" && !(await liveModeEnabled(session.liveOrgId))) {
    await ensureSandbox(session);
    jar.set(ENV_COOKIE, "sandbox", persisted);
    jar.set(ORG_COOKIE, session.liveOrgId, persisted);
    redirect("/m");
  }
  if (set === "sandbox") await ensureSandbox(session);
  jar.set(ENV_COOKIE, set, persisted);
  jar.set(ORG_COOKIE, session.liveOrgId, persisted);
  redirect(next);
}
