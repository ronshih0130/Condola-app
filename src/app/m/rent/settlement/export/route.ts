import { NextResponse } from "next/server";
import { makeT } from "@/i18n";
import { taipeiToday } from "@/server/money";
import { can } from "@/server/perms";
import { loadRentSettlement } from "@/server/rent-settlement";
import { settlementCsv } from "@/server/rent-settlement-math";
import { readSession } from "@/server/session";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const session = await readSession();
  if (!session || session.kind !== "staff" || !can(session.role, "stmt.view")) {
    return NextResponse.json({ error: "errors.forbidden" }, { status: 403 });
  }
  const month = new URL(request.url).searchParams.get("month") ?? undefined;
  const page = await loadRentSettlement(session, month, taipeiToday());
  if (!page) return NextResponse.json({ error: "errors.forbidden" }, { status: 403 });
  const t = makeT(session.locale);
  const body = settlementCsv(page.owners, {
    owner: t("i_owner"),
    month: t("i_month"),
    currency: t("i_settle_currency"),
    rent: t("i_settle_rent"),
    fee: t("i_settle_fee"),
    net: t("i_settle_net"),
  });
  return new NextResponse(body, {
    headers: {
      "content-type": "text/csv; charset=utf-8",
      "content-disposition": `attachment; filename="owner-settlement-${page.month}.csv"`,
      "cache-control": "private, no-store",
    },
  });
}
