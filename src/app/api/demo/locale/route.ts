import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { isLocale } from "@/i18n";
import { appCookieOptions, sameAppPath } from "@/server/public-origin";

function safeNext(value: string | null) {
  return sameAppPath(value) || "/";
}

export async function GET(request: Request) {
  const url = new URL(request.url);
  const set = url.searchParams.get("set");
  const jar = await cookies();
  if (isLocale(set)) jar.set("condola_locale", set, appCookieOptions({ httpOnly: false }));
  redirect(safeNext(url.searchParams.get("next")));
}
