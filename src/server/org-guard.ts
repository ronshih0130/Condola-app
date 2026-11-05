import type { Client } from "pg";
import { tx, type TxScope } from "./db";
import { FlowError } from "./errors";
import type { Session } from "./types";

export function requireOrgScope(session: Session): TxScope {
  if (
    typeof session.orgId !== "string" ||
    !session.orgId.trim() ||
    (session.environment !== "live" && session.environment !== "sandbox")
  ) {
    throw new FlowError("errors.forbidden");
  }
  return { orgId: session.orgId, environment: session.environment };
}

export function assertSameOrg(session: Session, resourceOrgId: string | null | undefined): void {
  if (!resourceOrgId || resourceOrgId !== session.orgId) {
    throw new FlowError("errors.forbidden");
  }
}

export function txForSession<T>(
  session: Session,
  fn: (client: Client) => Promise<T>,
  options?: { isolation?: "repeatable read" | "serializable"; readOnly?: boolean },
): Promise<T> {
  return tx(session.userId, fn, requireOrgScope(session), options);
}
