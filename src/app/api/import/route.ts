import { NextResponse } from "next/server";
import { FlowError } from "@/server/errors";
import { commitImportBatch, dryRunImport, readImportBody } from "@/server/import-batch";
import { readSession } from "@/server/session";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const session = await readSession();
  if (!session || session.kind !== "staff") return NextResponse.json({ error: "errors.forbidden" }, { status: 401 });
  try {
    const body = await readImportBody(request);
    const result =
      body.mode === "commit"
        ? await commitImportBatch(session, { fileName: body.fileName, rows: body.rows })
        : await dryRunImport(session, { fileName: body.fileName, rows: body.rows });
    return NextResponse.json(result);
  } catch (error) {
    if (error instanceof FlowError) {
      const status = error.key === "errors.forbidden" ? 403 : 400;
      return NextResponse.json({ error: error.key, vars: error.vars ?? {} }, { status });
    }
    console.error("import failed");
    return NextResponse.json({ error: "errors.generic" }, { status: 500 });
  }
}
