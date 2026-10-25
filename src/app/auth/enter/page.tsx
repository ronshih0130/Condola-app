import { redirect } from "next/navigation";
import { resolveEntryLocation } from "@/server/consent-gate";
import { readSession } from "@/server/session";

export const dynamic = "force-dynamic";

/**
 * Flight redirect, not an HTTP 303. The login action lands here so the
 * App Router updates the address to the consent gate or the destination.
 * Cookie expiry for every condola_env variant is attached in middleware.
 */
export default async function EnterPage({ searchParams }: { searchParams: Promise<{ next?: string }> }) {
  const params = await searchParams;
  const session = await readSession();
  redirect(await resolveEntryLocation(params.next ?? null, session));
}
