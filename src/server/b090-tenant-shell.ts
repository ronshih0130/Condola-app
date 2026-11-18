import { handoverCopy } from "../i18n/handover";
import { makeT } from "../i18n";
import { centerCopy } from "../i18n/lanes/notification-center";
import { reminderCopy } from "../i18n/lanes/reminders";
import { lineTenantCopy } from "../i18n/line-tenant";
import { tenantLeaseHistoryCopy } from "../i18n/tenant-lease-history";
import { readHandover } from "./handover";
import { centerSessionAdmission } from "./notification-center";
import { tenantLeases } from "./queries";
import { displaySampleName } from "./sandbox-data";
import { tenantDuePreference } from "./tenant-reminder-preferences";
import type { Session } from "./types";

/** One phone-tab / 更多 entry (same shape as the v3 ShellEntry). */
export type TenantShellEntry = { id: string; href: string; label: string; icon: "doc" | "box" | "bell" | "chat" };
export type TenantShellView = {
  name: string; place: string | null; company: string; canSwitchToOwner: boolean;
  more: TenantShellEntry[]; notification: { id: string; href: string; label: string; icon: "bell" } | null;
};

/**
 * B-090 slice 1 (TEN-55-AC1): what the brand_v3 tenant shell needs. Only existing readers and existing routes:
 * 更多 lists the tenant pages that the legacy layout and legacy 首頁 linked to (我的租約, ended leases, 點交,
 * the due-reminder preference, LINE settings), each only when the legacy page would have shown its link.
 * The bell is the legacy notification-center entry. A failed optional read hides that entry, never the shell.
 */
export async function tenantShellView(session: Session, lineEnabled: boolean): Promise<TenantShellView> {
  const leases = await tenantLeases(session);
  const lease = leases.length > 1 && !session.leaseId ? null : leases.find(l => l.lease_id === session.leaseId) ?? leases[0] ?? null;
  const [admission, handover, reminder] = await Promise.all([
    centerSessionAdmission(session).catch(() => "disabled" as const),
    lease ? readHandover(session, lease.lease_id).then(() => true, () => false) : false,
    lease ? tenantDuePreference(session, lease.lease_id).then(value => value !== null, () => false) : false,
  ]);
  const t = makeT(session.locale);
  const more: TenantShellEntry[] = [{ id: "lease", href: "/t/lease", label: t("i_rich_lease"), icon: "doc" }];
  more.push({ id: "history", href: "/t/history", label: tenantLeaseHistoryCopy(session.locale).link, icon: "doc" });
  if (lease && handover) more.push({ id: "handover", href: `/t/handover/${lease.lease_id}`, label: handoverCopy(session.locale).title, icon: "box" });
  if (lease && reminder) more.push({ id: "reminders", href: `/t/reminders/${lease.lease_id}`, label: reminderCopy(session.locale).tenantTitle, icon: "bell" });
  if (lineEnabled) more.push({ id: "line", href: `/t/liff?org=${encodeURIComponent(session.orgId)}&mode=manage`, label: lineTenantCopy(session.locale).manage, icon: "chat" });
  const place = lease ? displaySampleName([lease.property_name, lease.unit_label, lease.room_label].filter(Boolean).join(" ")) : null;
  return {
    name: session.name, place, company: (lease ?? leases[0])?.firm_name ?? "",
    canSwitchToOwner: Boolean(session.portals?.owner && session.portals.tenant),
    more,
    notification: admission === "enabled" || admission === "busy"
      ? { id: "notifications", href: "/t/notifications", label: centerCopy(session.locale).title, icon: "bell" } : null,
  };
}
