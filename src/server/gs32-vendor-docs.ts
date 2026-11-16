import type { Client } from "pg";
import { brandV3EnabledForOrg } from "./brand-v3";
import { many, maybe, svc, tx } from "./db";
import { FlowError } from "./errors";
import { requireOrgScope } from "./org-guard";
import { can } from "./perms";
import { guardEffectiveSession, withEffectiveReadAuthority } from "./b017-custom-role-governance";
import { admitVendorDocumentsOrgOn, vendorDocumentsEnabled } from "./vendor-document-admission";
import { resolveVendorDocumentToken, vendorDocumentGrantOn } from "./vendor-receipt";
import { validTaxId } from "./vendor-receipt-rules";
import type { Session } from "./types";

/**
 * Round 7 batch 4, GS-32 vendor document screens that already have data (Tier 1, no schema):
 * - rec-type1-preview and rec-paper-upload on the B-025 document-grant page (/v/documents/[token]);
 * - DOC-VOID marks on the manager repair page's documents card.
 * Gate: the new vendor_docs_v3 flag (platform allowlist + org flag; absent = OFF), effective brand_v3 and the
 * existing B-025 vendor_documents admission. Reads only; every write stays on the existing B-025 actions.
 */

/** platform_settings.vendor_docs_v3 {enabled:true, allowed_org_ids:[org]} and organizations.feature_flags.vendor_docs_v3 === true. */
export async function vendorDocsV3FlagOn(client: Pick<Client, "query">, orgId: string) {
  const row = (await client.query<{ value: { enabled?: unknown; allowed_org_ids?: unknown } | null; flag: unknown }>(
    `SELECT (SELECT value FROM public.platform_settings WHERE key='vendor_docs_v3') AS value,
            feature_flags->'vendor_docs_v3' AS flag FROM public.organizations WHERE id=$1`, [orgId])).rows[0];
  return row?.flag === true && row.value?.enabled === true && Array.isArray(row.value.allowed_org_ids)
    && row.value.allowed_org_ids.includes(orgId);
}

export type VendorDocsBrand = { name: string; company: string; property: string; status: string; ticketTitle: string; currency: string;
  /** VEN-21-AC8 (GS-57): the 買受人 is a company with a 統編; only then is the withholding note shown. */
  buyerIsCompany: boolean; buyerName: string | null };

/**
 * VEN-21-AC8 (GS-57 = A2), shared by the 簽收單 preview and the issued 簽收單: the withholding note shows only when
 * the 買受人 is a company with a valid 統編 (a management company or a company owner). An owner buyer is stored as a
 * receipt title only, with no 統編, so it is an individual here; so is a company selection without a valid 統編.
 * Accepts a grant buyer selection or an issued document's buyer snapshot.
 */
export function buyerIsCompanyWithTaxId(buyer: unknown): boolean {
  if (!buyer || typeof buyer !== "object") return false;
  const b = buyer as { kind?: unknown; tax_id?: unknown };
  return b.kind === "company" && typeof b.tax_id === "string" && validTaxId(b.tax_id);
}

/** Bearer presentation for the document-grant page: null when OFF or not admitted (the B-025 page stays). */
export async function vendorDocsV3Brand(token: string): Promise<VendorDocsBrand | null> {
  try {
    const found = await svc(null, async client => {
      const grant = await vendorDocumentGrantOn(client, token);
      await admitVendorDocumentsOrgOn(client, grant.org_id);
      const access = await resolveVendorDocumentToken(client, token);
      if (!(await vendorDocsV3FlagOn(client, access.orgId))) return null;
      const row = await maybe<{ company: string; property: string; status: string; title: string; name: string; currency: string }>(client,
        `SELECT o.name AS company, p.name AS property, t.status::text AS status, t.title, vp.display_name AS name,
                btrim(coalesce(t.currency, p.currency)) AS currency
           FROM public.maintenance_tickets t
           JOIN public.organizations o ON o.id=t.org_id
           JOIN public.properties p ON p.id=t.property_id AND p.org_id=t.org_id
           JOIN public.vendor_profiles vp ON vp.id=$3 AND vp.org_id=t.org_id
          WHERE t.org_id=$1 AND t.id=$2`, [access.orgId, access.ticket.id, access.profile.id]);
      if (!row) return null;
      const selection = access.buyerSelection;
      let buyerName: string | null = null;
      if (selection?.kind === "company") buyerName = selection.name?.trim() || null;
      else if (selection?.kind === "owner") {
        buyerName = (await maybe<{ title: string | null }>(client,
          `SELECT nullif(btrim(c.receipt_title),'') AS title FROM public.property_owners po
             JOIN public.contacts c ON c.id=po.owner_contact_id AND c.org_id=po.org_id
            WHERE po.org_id=$1 AND po.property_id=$2 AND c.id=$3 AND c.is_owner AND c.archived_at IS NULL
              AND po.effective_from<=current_date AND (po.effective_to IS NULL OR po.effective_to>=current_date)
            ORDER BY po.effective_from DESC LIMIT 1`, [access.orgId, access.ticket.property_id, selection.contactId]))?.title ?? null;
      }
      return { orgId: access.orgId, brand: { name: row.name, company: row.company, property: row.property, status: row.status, ticketTitle: row.title,
        currency: row.currency, buyerIsCompany: buyerIsCompanyWithTaxId(selection), buyerName } };
    });
    if (!found || !(await brandV3EnabledForOrg(found.orgId))) return null;
    return found.brand;
  } catch {
    // Not admitted, OFF or unreadable: the existing B-025 page renders (it owns its own errors and 404).
    return null;
  }
}

type DocView = {
  profile: { kind: "business" | "individual"; display_name: string };
  eligibleKind: "receipt" | "completion_statement";
  itemsUnavailable?: boolean;
  totalMinor: string; receivedMinor: string;
  documents: Array<{ id: string; kind: "receipt" | "completion_statement"; doc_no: string; status: "issued" | "voided" }>;
  history?: Array<{ id: string; scans: Array<{ id: string; mime_type: string }> }>;
};
export type VendorDocsV3Stage =
  | { stage: "type1_preview" }
  | { stage: "receipt_evidence"; receipt: { id: string; docNo: string }; scans: Array<{ id: string; mime: string }> };

/**
 * Which approved frame this grant is in, or null for every state not drawn in 3.0 yet (the B-025 page stays):
 * - type 1 (individual issuer: completion statement, no tax id or stamp) with no valid document → 預覽簽收單;
 * - type 2 (business issuer issuing ordinary receipts) with an issued receipt → 收據頁 with its paper receipts.
 * Type 3 (uploaded invoice) has no data yet (B-065 issuer type, B-067 upload).
 */
export function vendorDocsV3Stage(view: DocView): VendorDocsV3Stage | null {
  const live = view.documents.filter(d => d.status === "issued");
  if (view.profile.kind === "individual" && view.eligibleKind === "completion_statement" && !view.itemsUnavailable
    && !live.some(d => d.kind === "completion_statement")) return { stage: "type1_preview" };
  const receipt = view.profile.kind === "business" ? live.find(d => d.kind === "receipt") : undefined;
  if (receipt) {
    const scans = (view.history ?? []).filter(h => h.id === receipt.id).flatMap(h => h.scans).map(s => ({ id: s.id, mime: s.mime_type }));
    return { stage: "receipt_evidence", receipt: { id: receipt.id, docNo: receipt.doc_no }, scans };
  }
  return null;
}

export type TicketDocument = {
  id: string; kind: "receipt" | "completion_statement"; docNo: string; status: "issued" | "voided";
  totalMinor: string; buyerName: string | null; issuedAt: string;
};
export type TicketDocuments = { state: "off" } | { state: "ready"; currency: string; documents: TicketDocument[] };

/** DOC-VOID (m-docs): live first in issue order, voided last. Pure so the order is unit-tested. */
export function orderTicketDocuments(rows: TicketDocument[]): TicketDocument[] {
  const rank = (d: TicketDocument) => d.status === "voided" ? 1 : 0;
  return [...rows].sort((a, b) => rank(a) - rank(b) || a.issuedAt.localeCompare(b.issuedAt) || a.id.localeCompare(b.id));
}

/**
 * Manager repair page documents card (P-ADM, P-MGR with tickets.update). Read through the existing member RLS
 * policy on vendor_documents; OFF (flag, brand_v3 or vendor_documents) answers "off" and the page shows nothing.
 */
export async function loadTicketDocuments(session: Session, ticketId: string): Promise<TicketDocuments> {
  session = await guardEffectiveSession(session, "tickets.update");
  // DOC-VOID's m-docs is drawn for P-ADM and P-MGR only; P-MNT and P-ACC get nothing here.
  if (session.kind !== "staff" || (session.role !== "admin" && session.role !== "manager") || !can(session, "tickets.update")) return { state: "off" };
  if (!(await brandV3EnabledForOrg(session.orgId))) return { state: "off" };
  const effective = session;
  return tx(effective.userId, client => withEffectiveReadAuthority(client, effective, "tickets.update", async () => {
    if (!(await vendorDocsV3FlagOn(client, session.orgId)) || !(await vendorDocumentsEnabled(client, session.orgId))) return { state: "off" as const };
    const ticket = await maybe<{ currency: string }>(client,
      `SELECT btrim(coalesce(t.currency, p.currency)) AS currency FROM maintenance_tickets t
         JOIN properties p ON p.id=t.property_id AND p.org_id=t.org_id WHERE t.org_id=$1 AND t.id=$2`, [session.orgId, ticketId]);
    if (!ticket) throw new FlowError("errors.notFound");
    const rows = await many<{ id: string; kind: TicketDocument["kind"]; doc_no: string; status: TicketDocument["status"]; total: string; buyer: Record<string, unknown> | null; issued_at: string }>(client,
      `SELECT id::text, kind, doc_no, status, total_minor::text AS total, buyer, issued_at::text
         FROM vendor_documents WHERE org_id=$1 AND ticket_id=$2`, [session.orgId, ticketId]);
    const documents = rows.map(r => ({
      id: r.id, kind: r.kind, docNo: r.doc_no, status: r.status, totalMinor: r.total, issuedAt: r.issued_at,
      buyerName: typeof r.buyer?.receipt_title === "string" ? r.buyer.receipt_title : typeof r.buyer?.name === "string" ? r.buyer.name : null,
    }));
    return { state: "ready" as const, currency: ticket.currency, documents: orderTicketDocuments(documents) };
  }), requireOrgScope(effective), { isolation: "repeatable read", readOnly: true });
}
