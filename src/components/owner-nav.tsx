"use client";

import Link from "next/link";
import { ownerRepairCopy } from "@/i18n/lanes/repair-owner-policy";
import { usePathname } from "next/navigation";
import { BrandImage } from "./brand";
import { useLocale, useT } from "./locale";

export function OwnerNav({
  children,
  properties = [],
  v2,
  repairPolicyIds = [],
}: {
  children: React.ReactNode;
  properties?: { id: string; name: string }[];
  v2?: boolean;
  repairPolicyIds?: string[];
}) {
  const t = useT();
  const locale = useLocale();
  const path = usePathname() || "/o";
  const items = [
    ["/o", "i_overview"],
    ["/o/statements", "i_owner_nav_stmt"],
    ["/o/approvals", "i_approvals"],
  ] as const;
  return (
    <div className="stage">
      <div className="phone">
        <div className="scr">
          <div className="liffh">
            <b>{t("i_mode_own")}</b>
          </div>
          <div className="liffb">
            <div className="portal-brand">
              <BrandImage variant="horizontal" alt={t("i_brand")} {...(v2 ? { v2: true, locale } : {})} />
            </div>
            {properties.length > 0 ? (
              <div data-testid="owner-properties">
                <div className="small muted">{t("i_assign_properties")}</div>
                {properties.map((property) => (
                  <div key={property.id} data-testid="owner-property">
                    {property.name}
                    {repairPolicyIds.includes(property.id) ? <div><Link data-testid="owner-repair-policy-entry" href={`/o/repair-policy/${property.id}`}>{ownerRepairCopy(locale).entry}</Link></div> : null}
                  </div>
                ))}
              </div>
            ) : null}
            {children}
          </div>
          <nav className="tnav">
            {items.map(([href, key]) => (
              <Link key={href} href={href} className={path === href ? "on" : ""}>
                {t(key)}
              </Link>
            ))}
            <form action="/api/auth/sign-out" method="post">
              <button type="submit" data-testid="owner-sign-out">
                {t("i_logout")}
              </button>
            </form>
          </nav>
        </div>
      </div>
    </div>
  );
}
