import { makeT } from "@/i18n";
import { writePdfDownload } from "@/server/audit";
import { maybe, svc } from "@/server/db";
import { ownerPrivacy, tenantDisplayNames } from "@/server/auth";
import { maskTenantNames } from "@/server/privacy";
import {
  buildLeasePdf,
  buildStatementPdf,
  canDownloadLeasePdf,
  canDownloadStatementPdf,
  type LeasePdfSource,
} from "@/server/pdf-docs";
import { leasePdfSource, statementPdfSource } from "@/server/queries";
import type { Session } from "@/server/types";

/** Addresses of the properties already on a statement the caller is allowed to read. */
async function statementAddresses(statementId: string) {
  const rows = await svc(null, (client) =>
    client.query<{ address: string }>(
      `SELECT DISTINCT btrim(p.address_display) AS address
         FROM owner_statement_lines l
         JOIN properties p ON p.id = l.property_id
        WHERE l.statement_id = $1
          AND btrim(coalesce(p.address_display, '')) <> ''
        ORDER BY 1`,
      [statementId],
    ),
  );
  return rows.rows.map((row) => row.address);
}

function actorRole(session: Session) {
  return session.role ?? session.kind;
}

/** Tenant RLS can see the lease but not the 屋主 contact row. The name is part of the lease they already opened. */
async function ownerNameForLease(session: Session, leaseId: string) {
  const row = await svc(session.userId, (client) =>
    maybe<{ owner_name: string | null }>(
      client,
      `SELECT c.display_name AS owner_name
         FROM leases l
         JOIN property_owners po ON po.property_id = l.property_id AND po.is_primary
         JOIN contacts c ON c.id = po.owner_contact_id
        WHERE l.id = $1
        LIMIT 1`,
      [leaseId],
    ),
  );
  return row?.owner_name ?? null;
}

function leaseSource(row: NonNullable<Awaited<ReturnType<typeof leasePdfSource>>>, ownerName: string | null): LeasePdfSource {
  return {
    id: row.id,
    orgId: row.orgId,
    documentSha256: row.documentSha256,
    currency: row.currency.trim(),
    rentMinor: Number(row.rentMinor),
    depositMinor: Number(row.depositMinor),
    depositMonths: row.depositMonths,
    depositOverrideReason: row.depositOverrideReason,
    dueDay: row.dueDay,
    rentFrequency: row.rentFrequency,
    startDate: row.startDate,
    endDate: row.endDate,
    place: row.place,
    tenant: row.tenant,
    ownerName,
    address: row.address,
    addressDisplay: row.addressDisplay,
    floor: row.floor,
    roomLabel: row.roomLabel,
    scope: row.partial ? "partial" : "whole",
    electricityMethod: row.electricityMethod,
    ratePerKwh: row.ratePerKwh,
    bankName: row.bankName,
  };
}

export async function leasePdfForSession(session: Session, id: string) {
  if (!canDownloadLeasePdf(session)) return null;
  const row = await leasePdfSource(session, id);
  if (!row) return null;
  if (session.kind === "staff" && row.orgId !== session.orgId) return null;
  const ownerName = row.ownerName ?? (session.kind === "tenant" ? await ownerNameForLease(session, row.id) : null);
  const doc = buildLeasePdf(leaseSource(row, ownerName), makeT(session.locale));
  await writePdfDownload(session.orgId, session.userId, actorRole(session), "leases", row.id, {
    document: "lease",
    document_sha256: doc.footerHash,
  });
  return doc;
}

export async function statementPdfForSession(session: Session, id: string) {
  if (!canDownloadStatementPdf(session)) return null;
  const found = await statementPdfSource(session, id);
  if (!found) return null;
  const { statement } = found;
  if (session.kind === "staff" && statement.orgId !== session.orgId) return null;
  const t = makeT(session.locale);
  let lines = found.lines;
  if (session.kind === "owner") {
    const privacy = await ownerPrivacy(statement.orgId);
    if (!privacy.showName) {
      const names = await tenantDisplayNames(statement.orgId);
      const hidden = t("i_tenant_hidden");
      lines = lines.map((line) => ({
        ...line,
        description: line.description ? maskTenantNames(line.description, names, hidden) : line.description,
      }));
    }
  }
  const doc = buildStatementPdf(
    {
      id: statement.id,
      orgId: statement.orgId,
      ownerName: statement.ownerName,
      companyProfile: statement.companyProfile?.data,
      companyProfileEnabled: statement.companyProfile != null,
      periodStart: statement.periodStart,
      periodEnd: statement.periodEnd,
      currency: statement.currency.trim(),
      opening: Number(statement.opening),
      rent: Number(statement.rent),
      other: Number(statement.other),
      fee: Number(statement.fee),
      expenses: Number(statement.expenses),
      payouts: Number(statement.payouts),
      closing: Number(statement.closing),
      lines: lines.map((line) => ({
        lineType: line.lineType,
        description: line.description,
        amount: Number(line.amount),
      })),
      addresses: await statementAddresses(statement.id),
      audience: session.kind === "owner" ? "owner" : "staff",
    },
    session.locale,
    session.calendar,
    t,
  );
  await writePdfDownload(session.orgId, session.userId, actorRole(session), "owner_statements", statement.id, {
    document: "statement",
    period: doc.footerHash,
  });
  return doc;
}
