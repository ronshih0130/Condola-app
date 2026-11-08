import { guardEffectiveSession, withEffectiveAuthority } from "@/server/b017-custom-role-governance";
import { tx } from "./db";
import { billingPreviewsEnabled } from "./billing-preview-rules";
import { assertPerm } from "./perms";
import { calculateStatement } from "./statement-calculation";
import type { Session } from "./types";

export async function statementPreview(session: Session, ownerId: string, month: string) {
  session = await guardEffectiveSession(session, "stmt.view");
  assertPerm(session,"stmt.view");
  return tx(session.userId, async (client) => withEffectiveAuthority(client, session, "stmt.view", async () => {
    if (!(await billingPreviewsEnabled(client,session.orgId))) return null;
    return calculateStatement(client,session.orgId,ownerId,month,undefined,{repairCostFilter:true});
  }), {orgId:session.orgId,environment:session.environment}, {isolation:"repeatable read",readOnly:true});
}
