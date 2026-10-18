import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { resetAndSeed } from "@/server/seed";

export async function POST() {
  await resetAndSeed();
  const jar = await cookies();
  jar.delete("condola_persona");
  jar.delete("condola_lease");
  jar.delete("condola_tryout_hide");
  jar.delete("condola_tenant_focus");
  redirect("/?reset=1");
}
