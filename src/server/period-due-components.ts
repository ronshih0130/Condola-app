import type { Client } from "pg";
import { billingPreviewsEnabled, monthlyRentPostingEnabled } from "./billing-preview-rules";
import { svcOn, tx } from "./db";
import type { PeriodDueComponentLine } from "./monthly-bill-types";
import { monthlyBounds } from "./monthly-billing-rules";
import { requireOrgScope } from "./org-guard";
import { isUuid } from "./repair-rules";
import type { Session } from "./types";

async function privileged<T>(
  client: Client,
  session: Session,
  fn: (serviceClient: Client) => Promise<T>,
): Promise<T> {
  const scoped: Client = Object.create(client);
  scoped.query = ((...args: unknown[]) => {
    if (args[0] === "BEGIN") {
      args[0] = "SAVEPOINT period_due_components";
    } else if (args[0] === "COMMIT") {
      args[0] = "RELEASE SAVEPOINT period_due_components";
    } else if (args[0] === "ROLLBACK") {
      args[0] = "ROLLBACK TO SAVEPOINT period_due_components";
    }
    return Reflect.apply(client.query, client, args);
  }) as Client["query"];

  try {
    return await svcOn(scoped, session.userId, fn);
  } finally {
    try {
      await client.query("SET LOCAL ROLE authenticated");
    } finally {
      await client.query(
        "SELECT set_config('request.jwt.claim.role','authenticated',true)",
      );
    }
  }
}

export async function recordPeriodDueComponent(
  session: Session,
  { leaseId, periodYm, component }: {
    leaseId: string;
    periodYm: string;
    component: PeriodDueComponentLine;
  },
): Promise<{ ok: true } | { ok: false; reason: string }> {
  if (
    session.kind !== "staff" ||
    !["admin", "accountant"].includes(session.role ?? "")
  ) {
    return { ok: false, reason: "forbidden" };
  }

  if (!isUuid(leaseId)) {
    return { ok: false, reason: "invalid" };
  }

  try {
    monthlyBounds(periodYm);
  } catch (error) {
    if (error instanceof TypeError) {
      return { ok: false, reason: "invalid" };
    }
    throw error;
  }

  if (
    typeof component.amountMinor !== "string" ||
    !/^[1-9][0-9]*$/.test(component.amountMinor) ||
    !/^[A-Z]{3}$/.test(component.currency) ||
    !component.sourceRefId?.trim()
  ) {
    return { ok: false, reason: "invalid" };
  }

  return tx(session.userId, async (client) => {
    if (
      !(await billingPreviewsEnabled(client, session.orgId)) ||
      !(await monthlyRentPostingEnabled(client, session.orgId))
    ) {
      return { ok: false as const, reason: "disabled" };
    }

    const lease = await client.query(
      "SELECT 1 FROM leases WHERE org_id = $1 AND id = $2",
      [session.orgId, leaseId],
    );
    if (lease.rows.length === 0) {
      return { ok: false as const, reason: "not_found" };
    }

    await privileged(client, session, async (serviceClient) => {
      await serviceClient.query(
        `INSERT INTO app.tenant_period_due_components
          (org_id, lease_id, period_ym, component_key, amount_minor,
           currency, source_ref_kind, source_ref_id, note, created_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
         ON CONFLICT (org_id, lease_id, period_ym, component_key, source_ref_kind, source_ref_id)
         DO NOTHING`,
        [
          session.orgId, leaseId, periodYm, component.componentKey,
          component.amountMinor, component.currency, component.sourceRefKind,
          component.sourceRefId ?? null, component.note ?? null, session.userId,
        ],
      );
    });
    return { ok: true as const };
  }, requireOrgScope(session));
}
