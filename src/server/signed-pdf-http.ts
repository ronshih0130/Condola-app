import { can } from "./perms";
import { consentCoversCurrent } from "./consent";
import { consentRequiredResponse } from "./consent-gate";
import type { OrgRole, Session } from "./types";

export const STAFF_SIGNED_PDF_ROLES = ["admin", "manager"] as const satisfies readonly OrgRole[];

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const privateHeaders = {
  "Cache-Control": "private, no-store",
  "X-Content-Type-Options": "nosniff",
};

export function signedPdfNotFound() {
  return new Response("Not found", { status: 404, headers: privateHeaders });
}

export function signedPdfLoginRedirect() {
  return new Response(null, { status: 307, headers: { Location: "/login", ...privateHeaders } });
}

export function staffRoleMayDownloadSignedPdf(session: Session): boolean {
  return session.kind === "staff" && !!session.role && (STAFF_SIGNED_PDF_ROLES as readonly string[]).includes(session.role) && (!session.customRole || can(session, "props.view"));
}

type FileBytes = { content: Uint8Array; file_name: string };

export async function tenantSignedPdfHttp(input: {
  session: Session | null;
  pdfId: string;
  leaseId: string | null;
  leaseOrgId: string | null;
  globallyEnabled: boolean;
  read: () => Promise<FileBytes | null>;
  audit: () => Promise<unknown>;
  logError: (error: unknown) => void;
}): Promise<Response> {
  if (!input.session) return signedPdfLoginRedirect();
  if (input.session.kind !== "tenant") return signedPdfNotFound();
  if (!consentCoversCurrent(input.session.consent ?? null)) return consentRequiredResponse();
  if (!input.globallyEnabled) return signedPdfNotFound();
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(input.pdfId)) return signedPdfNotFound();
  if (!input.leaseId || !input.leaseOrgId || input.leaseOrgId !== input.session.orgId) return signedPdfNotFound();
  try {
    const file = await input.read();
    if (!file) return signedPdfNotFound();
    await input.audit();
    const bytes = Uint8Array.from(file.content);
    return new Response(new Blob([bytes], { type: "application/pdf" }), {
      headers: {
        ...privateHeaders,
        "Content-Type": "application/pdf",
        "Content-Length": String(bytes.byteLength),
        "Content-Disposition": `attachment; filename="${encodeURIComponent(file.file_name)}"`,
      },
    });
  } catch (error) {
    input.logError(error);
    return new Response("Unavailable", { status: 503, headers: privateHeaders });
  }
}

export async function staffSignedPdfHttp(input: {
  session: Session | null;
  leaseId: string;
  pdfId: string;
  leaseOrgId: string | null;
  globallyEnabled: boolean;
  read: () => Promise<FileBytes | null>;
  audit: () => Promise<unknown>;
  logError: (error: unknown) => void;
}): Promise<Response> {
  if (!input.session) return signedPdfLoginRedirect();
  if (!staffRoleMayDownloadSignedPdf(input.session)) return signedPdfNotFound();
  if (!consentCoversCurrent(input.session.consent ?? null)) return consentRequiredResponse();
  if (!input.globallyEnabled) return signedPdfNotFound();
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (!uuid.test(input.leaseId) || !uuid.test(input.pdfId)) return signedPdfNotFound();
  if (!input.leaseOrgId || input.leaseOrgId !== input.session.orgId) return signedPdfNotFound();
  try {
    const file = await input.read();
    if (!file) return signedPdfNotFound();
    await input.audit();
    const bytes = Uint8Array.from(file.content);
    return new Response(new Blob([bytes], { type: "application/pdf" }), {
      headers: {
        ...privateHeaders,
        "Content-Type": "application/pdf",
        "Content-Length": String(bytes.byteLength),
        "Content-Disposition": `attachment; filename="${encodeURIComponent(file.file_name)}"`,
      },
    });
  } catch (error) {
    input.logError(error);
    return new Response("Unavailable", { status: 503, headers: privateHeaders });
  }
}

export async function legacyStaffSignedPdfHttp(input: {
  session: Session | null;
  leaseId: string;
  read: () => Promise<{ id: string; content: Uint8Array; file_name: string } | null>;
  audit: (pdfId: string) => Promise<unknown>;
  logError: (error: unknown) => void;
}): Promise<Response> {
  if (!input.session) return signedPdfLoginRedirect();
  if (!staffRoleMayDownloadSignedPdf(input.session)) return signedPdfNotFound();
  if (!consentCoversCurrent(input.session.consent ?? null)) return consentRequiredResponse();
  if (!UUID.test(input.leaseId)) return signedPdfNotFound();
  try {
    const file = await input.read();
    if (!file || !UUID.test(file.id)) return signedPdfNotFound();
    await input.audit(file.id);
    const bytes = Uint8Array.from(file.content);
    return new Response(new Blob([bytes], { type: "application/pdf" }), {
      headers: {
        ...privateHeaders,
        "Content-Type": "application/pdf",
        "Content-Length": String(bytes.byteLength),
        "Content-Disposition": `attachment; filename="${encodeURIComponent(file.file_name)}"`,
      },
    });
  } catch (error) {
    input.logError(error);
    return new Response("Unavailable", { status: 503, headers: privateHeaders });
  }
}
