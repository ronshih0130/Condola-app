import { cookies } from "next/headers";
import { RESET_FLASH_COOKIE } from "@/server/reset-flash";

/** Drop the one-time reset confirmation without a server-action refresh. */
export async function POST() {
  const jar = await cookies();
  jar.delete({ name: RESET_FLASH_COOKIE, path: "/forgot" });
  return new Response(null, { status: 204 });
}
