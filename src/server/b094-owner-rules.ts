import { cache } from "react";
import { ownerPrivacy } from "./auth";
import { ownerRuleView, type OwnerRuleView } from "./b091-owner-rules";
import { ownerRepairPolicyEntryIds, ownerRepairPolicyView } from "./repair-owner-policy";
import { ownerPropertyNames } from "./queries";
import type { Session } from "./types";

/**
 * B-094 / RO-RULES (更多 › 授權規則, OWN-34). The renewal rule is B-091 (owner_rules, brand_v3); the repair
 * limits are the existing B-021 owner repair policy, one line per property that has a policy entry, each
 * with 「修改」 to its own policy page. Read-only here: the only write is setOwnerRule through its action.
 */
export type RepairLimitLine = { propertyId: string; name: string; minor: string | null; currency: string; minorUnit: number };
export type OwnerRulesPage =
  | { state: "off" | "forbidden" | "unavailable" }
  | { state: "ready"; rule: Extract<OwnerRuleView, { state: "ready" }>; repairs: RepairLimitLine[]; company: string };

/**
 * One B-091 rule read per request: the layout (更多 entry), the route (off → 404) and the page body share it.
 * getSession is request-cached, so the same session object is the key.
 */
export const ownerRuleViewOnce = cache((session: Session) => ownerRuleView(session));

type Deps = {
  rule?: typeof ownerRuleView;
  names?: typeof ownerPropertyNames;
  entries?: typeof ownerRepairPolicyEntryIds;
  policy?: typeof ownerRepairPolicyView;
  firm?: typeof ownerPrivacy;
};

/** Live only while the renewal rule is (owner_rules ON under brand_v3); OFF is a 404 for the page and no 更多 entry. */
export async function ownerRulesPage(session: Session, deps: Deps = {}): Promise<OwnerRulesPage> {
  const rule = await (deps.rule ?? ownerRuleViewOnce)(session);
  if (rule.state !== "ready") return { state: rule.state };
  try {
    const properties = await (deps.names ?? ownerPropertyNames)(session);
    const ids = await (deps.entries ?? ownerRepairPolicyEntryIds)(session, properties.map(p => p.id));
    const repairs: RepairLimitLine[] = [];
    for (const property of properties.filter(p => ids.includes(p.id))) {
      const view = await (deps.policy ?? ownerRepairPolicyView)(session, property.id);
      // A policy that is off or recovery-only for this property is not offered here (as in today's 更多 list).
      if (view.state === "disabled" || view.state === "recovery_only") continue;
      // One unreadable policy makes the page's read fail in place, never a partial or guessed limit.
      if (view.state !== "enabled") return { state: "unavailable" };
      repairs.push({ propertyId: property.id, name: property.name, minor: view.effectiveMinor, currency: view.currency, minorUnit: view.minorUnit });
    }
    // 「改了會通知{company}」: the firm name, read only after the B-091 gateway admitted this owner.
    const company = (await (deps.firm ?? ownerPrivacy)(session.orgId)).name;
    return { state: "ready", rule, repairs, company };
  } catch {
    return { state: "unavailable" };
  }
}

/** RO-MORE / OV-SH-MORE: the 更多 entry shows only while the page is live; a failed read hides it. */
export async function ownerRulesAvailable(session: Session, deps: Pick<Deps, "rule"> = {}): Promise<boolean> {
  try { return (await (deps.rule ?? ownerRuleViewOnce)(session)).state === "ready"; } catch { return false; }
}
