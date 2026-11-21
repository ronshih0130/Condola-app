import { HashOrRedirect } from "@/components/auth-hash";
import { readSession } from "@/server/session";
import { brandV3EnabledForOrg } from "@/server/brand-v3";
import { landingV3 } from "@/server/nav-v3";

export const dynamic = "force-dynamic";

export default async function Home({ searchParams }: { searchParams: Promise<{ reset?: string }> }) {
  const params = await searchParams;
  const session = await readSession();
  const demoReset = params.reset === "1" ? "?demoReset=1" : "";
  const home = session?.kind === "staff" && await brandV3EnabledForOrg(session.orgId)
    ? landingV3(session) : "/m";
  return <HashOrRedirect next={session ? `${home}${demoReset}` : `/login${demoReset}`} />;
}
