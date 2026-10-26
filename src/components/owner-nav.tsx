"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { BrandImage } from "./brand";
import { useT } from "./locale";

export function OwnerNav({
  children,
  properties = [],
}: {
  children: React.ReactNode;
  properties?: { id: string; name: string }[];
}) {
  const t = useT();
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
              <BrandImage variant="horizontal" alt={t("i_brand")} />
            </div>
            {properties.length > 0 ? (
              <div data-testid="owner-properties">
                <div className="small muted">{t("i_assign_properties")}</div>
                {properties.map((property) => (
                  <div key={property.id} data-testid="owner-property">
                    {property.name}
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
