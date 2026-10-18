"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useT } from "./locale";

export function OwnerNav({ children }: { children: React.ReactNode }) {
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
          <div className="liffb">{children}</div>
          <nav className="tnav">
            {items.map(([href, key]) => (
              <Link key={href} href={href} className={path === href ? "on" : ""}>
                {t(key)}
              </Link>
            ))}
            <a href="/api/demo/mode?mode=mgr">{t("i_logout")}</a>
          </nav>
        </div>
      </div>
    </div>
  );
}
