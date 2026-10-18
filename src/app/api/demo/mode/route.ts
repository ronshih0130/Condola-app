import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { USERS } from "@/server/ids";

const STAFF = new Set<string>([USERS.admin, USERS.manager, USERS.accountant, USERS.maintenance]);

function safeNext(value: string | null, fallback: string) {
  if (!value || !value.startsWith("/") || value.startsWith("//")) return fallback;
  return value;
}

export async function GET(request: Request) {
  const url = new URL(request.url);
  const mode = url.searchParams.get("mode");
  const jar = await cookies();
  if (mode === "ten") {
    const focus = jar.get("condola_tenant_focus")?.value;
    jar.set("condola_persona", focus && /^[0-9a-f-]{36}$/i.test(focus) ? focus : USERS.tenant, { path: "/", sameSite: "lax" });
    redirect(safeNext(url.searchParams.get("next"), "/t"));
  }
  if (mode === "own") {
    jar.set("condola_persona", USERS.owner, { path: "/", sameSite: "lax" });
    redirect(safeNext(url.searchParams.get("next"), "/o"));
  }
  const current = jar.get("condola_persona")?.value;
  jar.set("condola_persona", current && STAFF.has(current) ? current : USERS.admin, { path: "/", sameSite: "lax" });
  redirect(safeNext(url.searchParams.get("next"), "/m"));
}
