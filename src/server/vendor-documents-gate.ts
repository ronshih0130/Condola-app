import { admitVendorDocumentsOrgOn } from "./vendor-document-admission";
export { vendorDocumentsEnabled } from "./vendor-document-admission";
import { attachVendorPaperScanOn, readVendorPaperScanOn, updateVendorFixedDataOn, vendorDocumentHistoryOn, type FixedDataUpdate } from "./vendor-document-integrity";
import { isTradeLine, tradeLineItems, tradeTotal, type TradeLineInput, type TradeLineItem } from "./vendor-document-trade-rules";
import type { Client } from "pg";
import { many, maybe, one, svc } from "./db";
import { FlowError } from "./errors";
import { deriveTicketDocumentItems, type JobTypeLineItem } from "./job-types-rules";
import {
  issueVendorDocumentOn, previewVendorDocumentOn, readVendorDocumentPdfOn,
  resolveVendorDocumentToken, vendorDocumentGrantOn, voidVendorDocumentOn,
  type VendorDocumentContext,
} from "./vendor-receipt";
import { decideDocumentKind, type VendorDocumentKind } from "./vendor-receipt-rules";

async function admitted(client: Client, token: string) {
  const grant = await vendorDocumentGrantOn(client, token);
  // Hold admission through the entire operation, including PDF persistence.
  await admitVendorDocumentsOrgOn(client, grant.org_id);
  return resolveVendorDocumentToken(client, token);
}

type Access = Awaited<ReturnType<typeof admitted>>;

async function summaryOn(client: Client, access: Access) {
  const rows = await many<{ amount_minor: string; created_at: string }>(client,
    "SELECT * FROM app.b025_received_summary($1,$2)", [access.orgId, access.grantId]);
  return {
    receivedMinor: rows.reduce((sum, row) => sum + BigInt(row.amount_minor), BigInt(0)).toString(),
    marks: rows.map((row) => ({ amountMinor: row.amount_minor, createdAt: row.created_at })),
  };
}

async function markOn(client: Client, access: Access, input: { requestId: string; amountMinor: string }) {
  if (!/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(input.requestId)
    || typeof input.amountMinor !== "string" || !/^[1-9][0-9]{0,18}$/.test(input.amountMinor)
    || BigInt(input.amountMinor) > BigInt("9223372036854775807")) throw new FlowError("errors.required");
  return one<{ id: string }>(client, "SELECT app.b025_record_received($1,$2,$3,$4)::text AS id",
    [access.orgId, access.grantId, input.requestId, input.amountMinor]);
}

export async function recordReceived(token: string, input: { requestId: string; amountMinor: string }) {
  return svc(null, async (client) => markOn(client, await admitted(client, token), input));
}

export async function receivedSummary(token: string) {
  return svc(null, async (client) => summaryOn(client, await admitted(client, token)));
}

async function contextOn(client: Client, access: Access) {
  const cents = access.ticket.final_cost_minor;
  if (cents === null || !/^\d+$/.test(cents) || BigInt(cents) % BigInt(100) !== BigInt(0)) {
    throw new FlowError("errors.amount");
  }
  const totalMinor = (BigInt(cents) / BigInt(100)).toString();
  // Existing tickets have a final cost and persisted pricing. Use the work-order
  // title as the default single service row; issued snapshots retain their rows.
  const prior = await maybe<{ items: (JobTypeLineItem | TradeLineItem)[] }>(client,
    `SELECT items FROM vendor_documents WHERE org_id=$1 AND ticket_id=$2 AND vendor_profile_id=$3
      ORDER BY issued_at DESC,id DESC LIMIT 1`, [access.orgId, access.ticket.id, access.profile.id]);
  const total = Number(totalMinor);
  if (!Number.isSafeInteger(total)) throw new FlowError("errors.amount");
  // Multi-row work-order pricing has no authoritative per-row names/amounts on the
  // ticket; the token surface then fails closed (issuance needs a staff-built document).
  let items: (JobTypeLineItem | TradeLineItem)[] = [], itemsUnavailable = false;
  try {
    items = prior?.items.length && prior.items.every(isTradeLine) ? tradeLineItems(prior.items) : deriveTicketDocumentItems((prior?.items as JobTypeLineItem[] | undefined) ?? [{
      name: access.ticket.title, quantity: 1, unit: "", unit_price_minor: total,
      amount_minor: total, category: "service",
    }], access.ticket.type_fields);
  } catch (error) {
    if (!(error instanceof Error) || error.message !== "invalid_ticket_pricing") throw error;
    itemsUnavailable = true;
  }
  const selection = access.buyerSelection!;
  let titlePresent = selection.kind === "company" && Boolean(selection.name?.trim());
  if (selection.kind === "owner") {
    const owner = await maybe<{ present: boolean }>(client,
      `SELECT nullif(btrim(c.receipt_title),'') IS NOT NULL AS present
       FROM property_owners po JOIN contacts c ON c.id=po.owner_contact_id AND c.org_id=po.org_id
       WHERE po.org_id=$1 AND po.property_id=$2 AND c.id=$3 AND c.is_owner AND c.archived_at IS NULL
         AND po.effective_from<=current_date AND (po.effective_to IS NULL OR po.effective_to>=current_date)
       LIMIT 1`, [access.orgId, access.ticket.property_id, selection.contactId]);
    titlePresent = owner?.present === true;
  }
  const documents = await many<{
    id: string; kind: VendorDocumentKind; doc_no: string; status: "issued" | "voided";
    issued_at: string; reissued_from: string | null;
  }>(client, `SELECT id::text,kind,doc_no,status,issued_at::text,reissued_from::text
    FROM vendor_documents WHERE org_id=$1 AND ticket_id=$2 AND vendor_profile_id=$3
    ORDER BY issued_at,id`, [access.orgId, access.ticket.id, access.profile.id]);
  return {
    ticketNumber: access.ticket.ticket_number, items, itemsUnavailable, totalMinor,
    buyer: { kind: selection.kind, titlePresent },
    eligibleKind: decideDocumentKind({ kind: access.profile.kind, tax_id: access.profile.tax_id,
      qualification_attested: access.profile.qualification_attested_at !== null }),
    documents, history: await vendorDocumentHistoryOn(client, access), profileVersion: access.profile.current_version, ...await summaryOn(client, access),
  };
}

export async function vendorDocumentContext(token: string) {
  try {
    return await svc(null, async (client) => contextOn(client, await admitted(client, token)));
  } catch (error) {
    if (error instanceof FlowError && error.key === "errors.notFound") return null;
    throw error;
  }
}

export type VendorDocumentAction =
  | { action: "context" }
  | { action: "history" }
  | { action: "update_fixed_data"; update: FixedDataUpdate }
  | { action: "attach_scan"; documentId: string; requestId: string; mimeType: string; base64: string }
  | { action: "mark_received"; requestId: string; amountMinor: string }
  | { action: "void"; documentId: string; reason: string }
  | { action: "preview" | "issue" | "reissue"; kind: VendorDocumentKind; documentDate: string;
      idempotencyKey?: string; documentId?: string; tradeItems?: readonly TradeLineInput[];
      received?: { requestId: string; amountMinor: string } };

/** One-step mark+issue is one transaction; a failed issue leaves no mark. */
export async function vendorDocumentAction(token: string, input: VendorDocumentAction) {
  return svc(null, async (client) => {
    const access = await admitted(client, token);
    if (input.action === "context") return contextOn(client, access);
    if (input.action === "history") return vendorDocumentHistoryOn(client, access);
    if (input.action === "update_fixed_data") return updateVendorFixedDataOn(client, access, input.update);
    if (input.action === "attach_scan") return attachVendorPaperScanOn(client, access, input);
    if (input.action === "mark_received") return markOn(client, access, input);
    if (input.action === "void") return voidVendorDocumentOn(client, token, input.documentId, input.reason);
    const context = await contextOn(client, access);
    if (context.itemsUnavailable && !input.tradeItems) throw new FlowError("errors.vendorDocumentItemsUnavailable");
    const exactItems = input.tradeItems ? tradeLineItems(input.tradeItems)
      : context.items.length && context.items.every(isTradeLine) ? tradeLineItems(context.items) : undefined;
    if (exactItems && tradeTotal(exactItems) !== BigInt(context.totalMinor)) throw new FlowError("errors.amount");
    const ctx: VendorDocumentContext = {
      actor: token, ticketId: access.ticket.id, vendorProfileId: access.profile.id,
      items: exactItems ? [] : context.items as JobTypeLineItem[], tradeItems: exactItems, totalMinor: Number(context.totalMinor),
      kind: input.kind, documentDate: input.documentDate,
    };
    if (input.action === "preview") {
      const preview = await previewVendorDocumentOn(client, ctx);
      return { document: preview.document, pdfBase64: Buffer.from(preview.bytes).toString("base64"), sha256: preview.sha256 };
    }
    // One-step mark+issue: an already-used idempotency key returns its document and never
    // appends another payment mark (replay with a fresh mark request id is not a new payment).
    const replay = input.idempotencyKey ? await maybe<{ id: string }>(client,
      `SELECT id::text FROM vendor_documents WHERE org_id=$1 AND idempotency_key=$2`, [access.orgId, input.idempotencyKey]) : null;
    if (input.received && !replay) await markOn(client, access, input.received);
    return issueVendorDocumentOn(client, ctx, input.idempotencyKey ?? "",
      input.action === "reissue" ? input.documentId : undefined);
  });
}

export async function vendorDocumentPdf(token: string, documentId: string) {
  return svc(null, async (client) => {
    await admitted(client, token);
    return readVendorDocumentPdfOn(client, token, documentId);
  });
}

/** Route preflight precedes action validation; invalid/disabled capabilities are 404. */
export async function vendorDocumentAvailable(token: string) {
  try {
    return await svc(null, async (client) => { await admitted(client, token); return true; });
  } catch (error) {
    if (error instanceof FlowError && error.key === "errors.notFound") return false;
    throw error;
  }
}

export async function vendorDocumentHistory(token: string) {
  return svc(null, async (client) => vendorDocumentHistoryOn(client, await admitted(client, token)));
}

export async function vendorPaperScan(token: string, id: string) {
  return svc(null, async (client) => readVendorPaperScanOn(client, await admitted(client, token), id));
}
