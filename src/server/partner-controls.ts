import { query, svc, tx } from "./db";
import { recordAudit } from "./audit-write";
import { FlowError } from "./errors";
import { requireOrgScope } from "./org-guard";
import { assertStaff, type Session } from "./types";
import { effectivePartnerOverride, partnerControlEnabled, type PartnerOverride, type PartnerOverrideKind } from "./partner-controls-rules";

type ControlFacts = { flags: unknown; platform: Record<string, unknown>; overrides: PartnerOverride[] };
export async function readPartnerControls(session: Session, now = new Date()) {
  const off = { pricingHide: false, unitOverride: null as PartnerOverride | null };
  if (session.kind !== "staff" || session.needsSandbox) return off;
  const scope = requireOrgScope(session);
  // One read / implicit transaction for OFF, with no role/pin setup or private
  // override read. Check canonical membership even when both controls are OFF.
  const { rows: rollout } = await query<Omit<ControlFacts, "overrides">>(
    `SELECT o.feature_flags AS flags,
       coalesce((SELECT jsonb_object_agg(key,value) FROM platform_settings
         WHERE key IN ('partner_pricing_hide','partner_unit_override')), '{}'::jsonb) AS platform
     FROM organizations o JOIN org_members m
       ON m.org_id=coalesce(o.live_org_id,o.id) AND m.user_id=$2 AND m.status='active'
     WHERE o.id=$1 AND o.environment::text=$3
       AND ((o.environment='live' AND o.live_org_id IS NULL)
         OR (o.environment='sandbox' AND o.live_org_id IS NOT NULL))`,
    [session.orgId, session.userId, session.environment]);
  const rolloutFacts = rollout[0];
  if (!rolloutFacts) throw new FlowError("errors.forbidden");
  if (!(["pricing_hide", "unit_override"] as const).some(kind => partnerControlEnabled(
    rolloutFacts.platform[`partner_${kind}`], rolloutFacts.flags, session.orgId, kind,
  ))) return off;
  // ON rechecks scope and flags in the existing protected RPC, so a kill or
  // membership change between the two reads cannot admit a stale override.
  return tx(session.userId, async (client) => {
    const { rows } = await client.query<{ facts: ControlFacts }>(
      `SELECT app.b027_read_controls($1) AS facts`, [session.orgId]);
    const facts = rows[0].facts;
    const effective = (kind: PartnerOverrideKind) => effectivePartnerOverride({
      platform: facts.platform[`partner_${kind}`], flags: facts.flags, orgId: session.orgId, kind,
      override: facts.overrides.find((o) => o.kind === kind) ?? null, now,
    });
    return { pricingHide: effective("pricing_hide") !== null, unitOverride: effective("unit_override") };
  }, scope, { readOnly: true });
}

export type PartnerControlCommand = {
  kind: PartnerOverrideKind;
  action: "create" | "renew" | "revoke";
  unitLimit: number | null;
  days: number | null;
  expectedRevision: number;
};
/** Trusted server entry point; the RPC rechecks canonical membership and both gates. */
export async function changePartnerOverride(session: Session, command: PartnerControlCommand): Promise<PartnerOverride | null> {
  assertStaff(session, ["admin"]);
  if (session.needsSandbox) throw new FlowError("errors.forbidden");
  const scope = requireOrgScope(session);
  return svc(session.userId, async (client) => {
    await client.query(`SELECT set_config('app.active_org_id',$1,true), set_config('app.env',$2,true)`,
      [session.orgId, session.environment]);
    const result = await client.query<{ result: PartnerOverride | null }>(
      `SELECT app.b027_change_override($1,$2,$3,$4,$5,$6) AS result`,
      [session.orgId, command.kind, command.action, command.unitLimit, command.days, command.expectedRevision]);
    const changed = result.rows[0].result;
    if (changed) await recordAudit(
      { orgId: "orgId" in scope ? scope.orgId : null, actorUserId: session.userId, actorRole: "admin" },
      { table: "b027_partner_overrides", rowId: session.orgId, action: command.action === "create" ? "insert" : "update",
        eventType: `partner_override_${command.action}`, reason: `partner_override_${command.action}`,
        newRow: { kind: changed.kind, revision: changed.revision, unit_limit: changed.unitLimit,
          starts_at: changed.startsAt, expires_at: changed.expiresAt, revoked: changed.revoked } }, client);
    return changed;
  });
}
