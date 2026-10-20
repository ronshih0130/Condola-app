import { NextResponse } from "next/server";
import {
  approveMatch,
  confirmPayment,
  createLease,
  createProperty,
  createTicket,
  generateStatement,
  importBankCsv,
  inviteTeammate,
  postMessage,
  recordPayment,
  rejectPayment,
  setOwnerPhoneVisibility,
  signLease,
  simulateTenantSignature,
  updateTicket,
} from "@/server/domain";
import { FlowError } from "@/server/errors";
import { readSession } from "@/server/session";
import type { Session } from "@/server/types";

type Handler = (session: Session, body: Record<string, never>) => Promise<unknown>;

const handlers: Record<string, Handler> = {
  createProperty: (session, body) => createProperty(session, body as never),
  createLease: (session, body) => createLease(session, body as never),
  simulateTenantSignature: (session, body) => simulateTenantSignature(session, String(body.leaseId ?? "")),
  signLease: (session, body) => signLease(session, body as never),
  recordPayment: (session, body) => recordPayment(session, body as never),
  confirmPayment: (session, body) => confirmPayment(session, String(body.paymentId ?? "")),
  rejectPayment: (session, body) => rejectPayment(session, String(body.paymentId ?? ""), String(body.reason ?? "")),
  importBankCsv: (session, body) => importBankCsv(session, String(body.csv ?? "")),
  approveMatch: (session, body) => approveMatch(session, String(body.suggestionId ?? "")),
  generateStatement: (session, body) => generateStatement(session, body as never),
  createTicket: (session, body) => createTicket(session, body as never),
  updateTicket: (session, body) => updateTicket(session, String(body.ticketId ?? ""), body as never),
  postMessage: (session, body) => postMessage(session, String(body.threadId ?? ""), String(body.body ?? "")),
  inviteTeammate: (session, body) => inviteTeammate(session, body as never),
  setOwnerPhoneVisibility: (session, body) =>
    setOwnerPhoneVisibility(session, String(body.propertyOwnerId ?? ""), Boolean(body.canView)),
};

export async function POST(request: Request, context: { params: Promise<{ action: string }> }) {
  const { action } = await context.params;
  const handler = handlers[action];
  if (!handler) return NextResponse.json({ error: "errors.notFound" }, { status: 404 });
  try {
    const session = await readSession();
    if (!session) return NextResponse.json({ ok: false, error: "errors.forbidden" }, { status: 401 });
    const body = (await request.json()) as Record<string, never>;
    const result = await handler(session, body);
    return NextResponse.json({ ok: true, result });
  } catch (error) {
    const key = error instanceof FlowError ? error.key : "errors.generic";
    const status = key === "errors.forbidden" ? 403 : 400;
    return NextResponse.json({ ok: false, error: key }, { status });
  }
}
