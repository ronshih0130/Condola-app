import { brandV3EnabledForOrg } from "./brand-v3";
import { landingV3 } from "./nav-v3";
import { roleHome } from "./perms";
import type { Session } from "./types";

/** Portal landings retain their existing path and do not need a brand lookup. */
export async function roleHomeForSession(session: Session) {
  return session.kind === "staff" && await brandV3EnabledForOrg(session.orgId)
    ? landingV3(session) : roleHome(session.kind, session.role);
}
