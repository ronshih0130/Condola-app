import Link from "next/link";
import type { Locale } from "@/i18n";
import { formatMoney } from "@/server/format";

export function SpaceRepairs({
  t,
  locale,
  repairs,
  href,
}: {
  t: (key: string) => string;
  locale: Locale;
  repairs: {
    id: string;
    number: string;
    title: string;
    vendor_name: string | null;
    final_cost: string | null;
    currency: string;
  }[];
  href: string;
}) {
  return (
    <div className="card pad" data-testid="space-repairs" style={{ marginTop: 16 }}>
      <h3>{t("i_repair_history")}</h3>
      {repairs.length === 0 ? <p className="small muted">{t("i_repair_none")}</p> : null}
      {repairs.map((repair) => {
        const cost = repair.final_cost ? formatMoney(repair.final_cost, repair.currency, locale) : "";
        const detail = [repair.vendor_name, cost].filter(Boolean).join(" · ");
        return (
          <div className="n" key={repair.id}>
            <Link href={`/m/tickets/${repair.id}`}>
              <b>
                #{repair.number} {repair.title}
              </b>
            </Link>
            {detail ? <div className="small muted">{detail}</div> : null}
          </div>
        );
      })}
      <p style={{ marginTop: 8 }}>
        <Link href={href}>{t("i_repair_open")}</Link>
      </p>
    </div>
  );
}
