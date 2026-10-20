import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { ENV_COOKIE, ORG_COOKIE } from "@/server/org-scope";
import { ensureSandbox } from "@/server/sandbox";
import { readSession } from "@/server/session";

function safeNext(value: string | null) {
  if (!value || !value.startsWith("/") || value.startsWith("//")) return "/m";
  return value;
}

export async function GET(request: Request) {
  const session = await readSession();
  if (!session || session.kind !== "staff") redirect("/login");
  const url = new URL(request.url);
  const set = url.searchParams.get("set");
  const next = safeNext(url.searchParams.get("next"));
  if (set === "sandbox") await ensureSandbox(session);
  if (set !== "sandbox" && set !== "live") redirect("/m");
  const jar = await cookies();
  jar.set(ENV_COOKIE, set, { path: "/", sameSite: "lax" });
  jar.set(ORG_COOKIE, session.liveOrgId, { path: "/", sameSite: "lax" });
  redirect(next);
}
