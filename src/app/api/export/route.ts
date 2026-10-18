import { NextResponse } from "next/server";
import { listProperties } from "@/server/queries";
import { getSession } from "@/server/session";

export async function GET() {
  const session = await getSession();
  if (session.kind !== "staff") return NextResponse.json({ error: "errors.forbidden" }, { status: 403 });
  const rows = await listProperties(session);
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
