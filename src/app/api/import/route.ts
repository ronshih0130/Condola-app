import { NextResponse } from "next/server";
import { FlowError } from "@/server/errors";
import { commitImportBatch, dryRunImport } from "@/server/import-batch";
import { readSession } from "@/server/session";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const session = await readSession();
  if (!session || session.kind !== "staff") return NextResponse.json({ error: "errors.forbidden" }, { status: 401 });
  let body: { mode?: unknown; fileName?: unknown; rows?: unknown };
  try {
    body = (await request.json()) as { mode?: unknown; fileName?: unknown; rows?: unknown };
  } catch {
    return NextResponse.json({ error: "errors.generic" }, { status: 400 });
  }
  const fileName = typeof body.fileName === "string" ? body.fileName : "";
  try {
    const result =
      body.mode === "commit"
        ? await commitImportBatch(session, { fileName, rows: body.rows })
        : await dryRunImport(session, { fileName, rows: body.rows });
    return NextResponse.json(result);
  } catch (error) {
    if (error instanceof FlowError) {
      const status = error.key === "errors.forbidden" ? 403 : 400;
      return NextResponse.json({ error: error.key, vars: error.vars ?? {} }, { status });
    }
    console.error(error);
    return NextResponse.json({ error: "errors.generic" }, { status: 500 });
  }
}
