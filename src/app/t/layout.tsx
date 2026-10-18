import Link from "next/link";
import { redirect } from "next/navigation";
import { makeT } from "@/i18n";
import { getSession } from "@/server/session";

export const dynamic = "force-dynamic";

export default async function TenantLayout({ children }: { children: React.ReactNode }) {
  const session = await getSession();
  if (session.kind !== "tenant") redirect("/m");
  const t = makeT(session.locale);
  const tiles = [
    ["/t/pay", "tenant-tile-pay", "i_rich_pay"],
    ["/t/repair", "tenant-tile-repair", "i_rich_repair"],
    ["/t/lease", "tenant-tile-lease", "i_rich_lease"],
    ["/t/messages", "tenant-tile-messages", "i_rich_msg"],
  ] as const;
  return (
    <div className="stage">
      <div className="phone" data-testid="liff-frame">
        <div className="scr">
          <div className="notch" />
          <div className="lhead">
            <span className="logo">{t("i_brand") === "Condola" ? "C" : "租"}</span>
            {t("i_brand")}
          </div>
          <div className="liffb">{children}</div>
          <div className="rich">
            <div className="gridm">
              {tiles.map(([href, testid, key]) => (
                <Link key={href} href={href} data-testid={testid}>
                  {t(key)}
                </Link>
              ))}
            </div>
          </div>
          <p className="fn">{t("i_line_stub")}</p>
        </div>
      </div>
    </div>
  );
}
