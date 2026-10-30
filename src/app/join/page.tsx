import { TeamJoin } from "@/components/team-join";
import { brandV2Enabled } from "@/server/brand-v2";

export const dynamic = "force-dynamic";

export default function JoinPage() {
  return <TeamJoin {...(brandV2Enabled() ? { brandV2: true } : {})} />;
}
