import { requireCurrentConsent } from "@/server/consent-gate";
import { decideBankMatch, importBankFile } from "@/server/bank-matching";
import { readSession } from "@/server/session";
import { NextResponse } from "next/server";

export async function POST(request: Request) {
  const session = await readSession();
  if (!session) return NextResponse.json({ok:false},{status:401});
  const blocked = await requireCurrentConsent(session,"api");
  if (blocked) return blocked;
  try {
    if (request.headers.get("content-type")?.startsWith("multipart/form-data")) {
      const form = await request.formData();
      const file = form.get("file"), account = form.get("account"), encoding = form.get("encoding"), dateFormat = form.get("dateFormat");
      if (!(file instanceof File) || file.size > 1_000_000 || typeof account !== "string" || (encoding !== "utf-8" && encoding !== "big5") || (dateFormat !== "iso" && dateFormat !== "roc")) return Response.json({ok:false},{status:400});
      const result = await importBankFile(session,account,new Uint8Array(await file.arrayBuffer()),encoding,dateFormat);
      return Response.json({ok:!!result,result},{status:result ? 200 : 403,headers:{"Cache-Control":"private, no-store"}});
    }
    const body = await request.json();
    if (!body || (body.decision !== "match" && body.decision !== "reject") || typeof body.bankId !== "string" || typeof body.reason !== "string") return Response.json({ok:false},{status:400});
    const result = await decideBankMatch(session,{bankId:body.bankId,decision:body.decision,reason:body.reason,paymentId:typeof body.paymentId === "string" ? body.paymentId : undefined,suggestionId:typeof body.suggestionId === "string" ? body.suggestionId : undefined});
    return Response.json({ok:result === true},{status:result ? 200 : 403,headers:{"Cache-Control":"private, no-store"}});
  } catch { return Response.json({ok:false},{status:400,headers:{"Cache-Control":"private, no-store"}}); }
}
