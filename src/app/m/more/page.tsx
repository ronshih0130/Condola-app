import { notFound } from "next/navigation";
import Link from "next/link";
import { requireCurrentConsent } from "@/server/consent-gate";
import { getSession } from "@/server/session";
import { brandV3EnabledForOrg } from "@/server/brand-v3";
import { areasFor, tabsFor, navLabel } from "@/server/nav-v3";
import { brandV3NavigationCopy } from "@/i18n/lanes/brand-v3";
import { ShellIcon } from "@/components/v3/shell/icon";

export const dynamic = "force-dynamic";

export default async function MorePage() {
  await requireCurrentConsent(undefined, "page");
  const session = await getSession();
  if (session.kind !== "staff") notFound();
  if (!(await brandV3EnabledForOrg(session.orgId))) notFound();
  const tabs = tabsFor(session);
  const remaining = areasFor(session).filter(area => !tabs.some(tab => tab.id === area.id));
  return <div className="v3-more">
    <h1>{brandV3NavigationCopy(session.locale).more}</h1>
    <div className="sheet">
      {remaining.map(area => <section key={area.id}>
        <Link href={area.href}><ShellIcon name={area.icon} /><span>{navLabel(area.key, session.locale)}</span></Link>
        {area.links.map(item => <Link className="sub" key={item.href} href={item.href}>{navLabel(item.key, session.locale)}</Link>)}
      </section>)}
    </div>
  </div>;
}
