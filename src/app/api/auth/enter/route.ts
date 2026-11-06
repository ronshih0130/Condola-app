import { guardEffectiveSession } from "@/server/b017-custom-role-governance";
import { resolveEntryLocation } from "@/server/consent-gate";
import { readSession } from "@/server/session";
import { expiredEnvChoiceCookies } from "@/server/sign-out";

/** Document navigation. Server actions use /auth/enter so the address bar follows. */
export async function GET(request: Request) {
  const session = await guardEffectiveSession(await readSession(), null);
  const location = await resolveEntryLocation(new URL(request.url).searchParams.get("next"), session);
  const headers = new Headers();
  headers.set("Cache-Control", "private, no-store");
  headers.set("Location", location);
  for (const line of expiredEnvChoiceCookies()) headers.append("Set-Cookie", line);
  return new Response(null, { status: 303, headers });
}
