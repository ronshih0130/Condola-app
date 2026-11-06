import { billingPreviewsEnabled, monthlyRentPostingEnabled } from "./billing-preview-rules";
import { svcOn, tx } from "./db";
import type { PeriodDueComponentLine } from "./monthly-bill-types";
import { requireOrgScope } from "./org-guard";
import type { Session } from "./types";

export async function recordPeriodDueComponent(
  session: Session,
  { leaseId, periodYm, component }: {
    leaseId: string;
    periodYm: string;
    component: PeriodDueComponentLine;
  },
): Promise<{ ok: true } | { ok: false; reason: string }> {
  return tx(session.userId, async (client) => {
    if (
      !(await billingPreviewsEnabled(client, session.orgId)) ||
      !(await monthlyRentPostingEnabled(client, session.orgId))
    ) {
      return { ok: false as const, reason: "disabled" };
    }
    await svcOn(client, session.userId, async (serviceClient) => {
      await serviceClient.query(
        `INSERT INTO app.tenant_period_due_components
          (org_id, lease_id, period_ym, component_key, amount_minor,
           currency, source_ref_kind, source_ref_id, note, created_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
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
