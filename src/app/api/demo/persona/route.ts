import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { loadPersona } from "@/server/session";

export async function GET(request: Request) {
  const id = new URL(request.url).searchParams.get("id") ?? "";
  if (!/^[0-9a-f-]{36}$/i.test(id)) redirect("/m");
  const jar = await cookies();
  jar.set("condola_persona", id, { path: "/", sameSite: "lax" });
  const persona = await loadPersona(id);
  redirect(persona.kind === "tenant" ? "/t" : persona.kind === "owner" ? "/o" : "/m");
}
