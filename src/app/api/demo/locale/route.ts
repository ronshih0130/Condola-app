import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { isLocale } from "@/i18n";

function safeNext(value: string | null) {
  if (!value || !value.startsWith("/") || value.startsWith("//")) return "/";
  return value;
}

export async function GET(request: Request) {
  const url = new URL(request.url);
  const set = url.searchParams.get("set");
  const jar = await cookies();
  if (isLocale(set)) jar.set("condola_locale", set, { path: "/", sameSite: "lax" });
  redirect(safeNext(url.searchParams.get("next")));
}
