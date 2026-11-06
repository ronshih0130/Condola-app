"use server";

import { guardEffectiveSession } from "@/server/b017-custom-role-governance";

import { requireCurrentConsent } from "./consent-gate";
import { withClient } from "./db";
import { recordMoveOutNotice } from "./move-out-notice";
import { requireOrgScope } from "./org-guard";
import { can } from "./perms";
import { getSession } from "./session";

/** The existing notice flag stays default off; org and actor are session-derived. */
export async function actionRecordMoveOut(leaseId: string, movedOutOn: string, reason = "") {
  await requireCurrentConsent();
  const session = await guardEffectiveSession(await getSession(), "leases.edit");
  if (session.kind !== "staff" || !can(session, "leases.edit") || session.needsSandbox) {
    return { ok: false as const, reason: "forbidden" as const };
  }
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(leaseId) ||
      typeof reason !== "string" || reason.length > 500) {
    return { ok: false as const, reason: "invalid" as const };
  }
  const scope = requireOrgScope(session) as { orgId: string; environment: "live" | "sandbox" };
  try {
    return await withClient((client) => recordMoveOutNotice(client, {
      orgId: scope.orgId,
      actorUserId: session.userId,
      liveOrgId: session.liveOrgId,
      environment: scope.environment,
      leaseId,
      movedOutOn,
      reason: reason.trim() || undefined,
    }));
  } catch (error) {
    if (error instanceof TypeError) return { ok: false as const, reason: "invalid" as const };
    throw error;
  }
}
