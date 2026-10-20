import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { appCookieOptions, sameAppPath } from "@/server/public-origin";

function safeNext(value: string | null) {
  return sameAppPath(value) || "/m";
}

export async function GET(request: Request) {
  const url = new URL(request.url);
  const jar = await cookies();
  if (url.searchParams.get("hide") === "1") {
    jar.set("condola_tryout_hide", "1", appCookieOptions({ httpOnly: false }));
  } else {
    jar.delete("condola_tryout_hide");
  }
  redirect(safeNext(url.searchParams.get("next")));
}
