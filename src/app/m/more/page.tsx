import Link from "next/link";
import { brandV3EnabledForOrg } from "@/server/brand-v3";
import { areasFor, tabsFor, navLabel } from "@/server/nav-v3";
import { maintUnitAssignEnabledForOrg } from "@/server/b059-maint-unit-assign";
import { brandV3NavigationCopy } from "@/i18n/lanes/brand-v3";
import { ShellIcon } from "@/components/v3/shell/icon";
import { withPageFlagGate } from "@/server/page-flag-gate";

export const dynamic = "force-dynamic";

export default withPageFlagGate({
  flagKey: "brand_v3",
  flag: async session => session.kind === "staff" && (await brandV3EnabledForOrg(session.orgId)),
}, async (_props: object, session) => {
  // B-059 (GS-46): the 設定 › 單位分派 row, as in the shell (brand_v3 is ON here: OFF was a 404 above).
  const nav = { maintAssign: ["admin", "manager"].includes(session.customRole?.nativeRole ?? session.role ?? "")
    ? await maintUnitAssignEnabledForOrg(session.orgId) : false };
  const tabs = tabsFor(session, nav);
  const remaining = areasFor(session, nav)
    .filter(area => !tabs.some(tab => tab.id === area.id))
    .map(area => ({ ...area, links: area.links.filter(item => item.href !== "/m/account") }))
    // Some roles have only My account in Settings; leave that empty card out too.
    .filter(area => area.href !== "/m/account" || area.links.length > 0);
  return <div className="v3-more">
    <h1>{brandV3NavigationCopy(session.locale).more}</h1>
    <div className="sheet">
      {remaining.map(area => <section key={area.id}>
        <Link href={area.href}><ShellIcon name={area.icon} /><span>{navLabel(area.key, session.locale)}</span></Link>
        {area.links.map(item => <Link className="sub" key={item.href} href={item.href}>{navLabel(item.key, session.locale)}</Link>)}
      </section>)}
    </div>
  </div>;
});
