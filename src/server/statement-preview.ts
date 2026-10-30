import { tx } from "./db";
import { billingPreviewsEnabled } from "./billing-preview-rules";
import { assertPerm } from "./perms";
import { calculateStatement } from "./statement-calculation";
import type { Session } from "./types";

export async function statementPreview(session: Session, ownerId: string, month: string) {
  assertPerm(session,"stmt.view");
  return tx(session.userId, async (client) => {
    if (!(await billingPreviewsEnabled(client,session.orgId))) return null;
    return calculateStatement(client,session.orgId,ownerId,month);
  }, {orgId:session.orgId,environment:session.environment}, {isolation:"repeatable read",readOnly:true});
}
