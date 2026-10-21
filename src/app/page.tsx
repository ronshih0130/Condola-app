import { HashOrRedirect } from "@/components/auth-hash";
import { readSession } from "@/server/session";

export const dynamic = "force-dynamic";

export default async function Home({ searchParams }: { searchParams: Promise<{ reset?: string }> }) {
  const params = await searchParams;
  const session = await readSession();
  const demoReset = params.reset === "1" ? "?demoReset=1" : "";
  return <HashOrRedirect next={session ? `/m${demoReset}` : `/login${demoReset}`} />;
}
