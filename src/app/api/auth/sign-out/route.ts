import { guardEffectiveSession } from "@/server/b017-custom-role-governance";
import { cookies } from "next/headers";
import { revokeAllSessions } from "@/server/auth";
import { sameAppPath } from "@/server/public-origin";
import { expiredAuthCookies } from "@/server/sign-out";
import { readSession } from "@/server/session";

export async function POST(request: Request) {
  const next = sameAppPath(new URL(request.url).searchParams.get("next"));
  const jar = await cookies();
  const extras = jar.getAll().map((cookie) => cookie.name).filter((name) => name.startsWith("sb-"));
  const headers = new Headers();
  headers.set("Cache-Control", "private, no-store");
  headers.set("Location", next.startsWith("/accept/") ? next : "/login");
  for (const line of expiredAuthCookies(extras)) headers.append("Set-Cookie", line);
  try {
    const session = await guardEffectiveSession(await readSession(), null);
    if (session) await revokeAllSessions(session.userId);
  } catch (error) {
    console.error("sign out", error);
  }
  return new Response(null, { status: 303, headers });
}
