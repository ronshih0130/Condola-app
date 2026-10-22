import { NextResponse } from "next/server";
import { withoutIdentityFields } from "@/lib/idv";
import { listProperties } from "@/server/queries";
import { getSession } from "@/server/session";

export async function GET() {
  const session = await getSession();
  if (session.kind !== "staff") return NextResponse.json({ error: "errors.forbidden" }, { status: 403 });
  const rows = withoutIdentityFields((await listProperties(session)).map((row) => ({ ...row })));
  const header = "name,address,currency,mode,rooms,owner";
  const body = rows
    .map((row) => [row.name, row.address_display, row.currency, row.rental_mode, row.rooms, row.owner_name ?? ""].map(csv).join(","))
    .join("\n");
  return new NextResponse(`\uFEFF${header}\n${body}\n`, {
    headers: {
      "content-type": "text/csv; charset=utf-8",
      "content-disposition": "attachment; filename=properties.csv",
    },
  });
}

function csv(value: string) {
  return `"${value.replaceAll('"', '""')}"`;
}
