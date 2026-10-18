import { cookies } from "next/headers";
import { redirect } from "next/navigation";

function safeNext(value: string | null) {
  if (!value || !value.startsWith("/") || value.startsWith("//")) return "/m";
  return value;
}

export async function GET(request: Request) {
  const url = new URL(request.url);
  const jar = await cookies();
  if (url.searchParams.get("hide") === "1") {
    jar.set("condola_tryout_hide", "1", { path: "/", sameSite: "lax" });
  } else {
    jar.delete("condola_tryout_hide");
  }
  redirect(safeNext(url.searchParams.get("next")));
}
