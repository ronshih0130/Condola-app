import { expiredEnvChoiceCookies } from "@/server/sign-out";
import { sameAppPath } from "@/server/public-origin";

export async function GET(request: Request) {
  const next = sameAppPath(new URL(request.url).searchParams.get("next")) || "/auth/continue";
  const headers = new Headers();
  headers.set("Cache-Control", "private, no-store");
  headers.set("Location", next);
  for (const line of expiredEnvChoiceCookies()) headers.append("Set-Cookie", line);
  return new Response(null, { status: 303, headers });
}
