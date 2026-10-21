"use client";

import { usePathname } from "next/navigation";
import { useT } from "./locale";

export function EnvBanner({ showBack }: { showBack: boolean }) {
  const t = useT();
  const path = usePathname() || "/m";
  const href = `/api/env?set=live&next=${encodeURIComponent(path)}`;
  return (
    <div className="env-banner" id="envBanner" data-testid="env-banner" role="status">
      <b>{t("i_sandbox_banner")}</b>
      {showBack ? (
        <a href={href} data-testid="env-banner-live">
          {t("i_sandbox_back")}
        </a>
      ) : null}
    </div>
  );
}
