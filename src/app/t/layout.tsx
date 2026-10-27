import { headers } from "next/headers";
import Link from "next/link";
import { redirect } from "next/navigation";
import { makeT } from "@/i18n";
import { BrandImage } from "@/components/brand";
import { brandV2Enabled } from "@/server/brand-v2";
import { requireCurrentConsent } from "@/server/consent-gate";
import { getSession } from "@/server/session";

export const dynamic = "force-dynamic";

export default async function TenantLayout({ children }: { children: React.ReactNode }) {
  const session = await getSession();
  if (session.kind !== "tenant") redirect("/m");
  const t = makeT(session.locale);
  const path = (await headers()).get("x-pathname") || "";
  await requireCurrentConsent(session, "page", path || "/t");
  const task = path === "/t/id" || path.startsWith("/t/id/");
  const backHref = path === "/t/id/notice" || path.startsWith("/t/id/notice/") ? "/t/id" : "/t";
  const tiles = [
    ["/t/pay", "tenant-tile-pay", "i_rich_pay"],
    ["/t/repair", "tenant-tile-repair", "i_rich_repair"],
    ["/t/lease", "tenant-tile-lease", "i_rich_lease"],
    ["/t/messages", "tenant-tile-messages", "i_rich_msg"],
  ] as const;
  return (
    <div className={task ? "stage task" : "stage"}>
      <div className="phone" data-testid="liff-frame">
        <div className="scr">
          {task ? null : <div className="notch" />}
          <div className="lhead">
            {task ? (
              <Link href={backHref} className="task-back" data-testid="task-back">
                {t("i_task_back")}
              </Link>
            ) : null}
            <BrandImage variant="symbolSmall" alt="" className="brand-symbol" />
            {t("i_brand")}
          </div>
          <div className="liffb" data-testid="bill-list">
            {path === "/t" ? (
              <div className="liff-welcome">
                <BrandImage variant="stacked" alt={t("i_brand")} {...(brandV2Enabled() ? { v2: true } : {})} />
              </div>
            ) : null}
            {children}
          </div>
          {task ? null : (
            <div className="rich" data-testid="tenant-nav">
              <div className="gridm">
                {tiles.map(([href, testid, key]) => (
                  <Link key={href} href={href} data-testid={testid}>
                    {t(key)}
                  </Link>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
