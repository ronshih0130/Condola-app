export type SignedPdfDownloadAudit = {
  orgId: string;
  userId: string;
  leaseId: string;
  pdfId: string;
  requestId: string;
};

type SignedPdfFile = {
  id: string;
  content: Uint8Array;
  size_bytes: number;
  file_name: string;
};

type DownloadDependencies = {
  read: () => Promise<SignedPdfFile | null>;
  audit: (event: SignedPdfDownloadAudit) => Promise<unknown>;
  logError: (tag: string, error: unknown) => void;
};

export const signedPdfPrivateHeaders = {
  "Cache-Control": "private, no-store",
  "X-Content-Type-Options": "nosniff",
};

/**
 * The caller checks session, consent, feature flag and selected lease first.
 * read must enforce tenant ownership and org/feature access through RLS.
 * Success means constructing a 200 response; HTTP cannot confirm client receipt.
 */
export async function tenantSignedPdfDownload(
  event: SignedPdfDownloadAudit,
  dependencies: DownloadDependencies,
) {
  const file = await dependencies.read();
  if (!file) {
    return new Response("Not found", {
      status: 404,
      headers: signedPdfPrivateHeaders,
    });
  }

  const response = new Response(new Blob([Uint8Array.from(file.content)], {
    type: "application/pdf",
  }), {
    headers: {
      ...signedPdfPrivateHeaders,
      "Content-Type": "application/pdf",
      "Content-Length": String(file.size_bytes),
      "Content-Disposition": `attachment; filename="${encodeURIComponent(file.file_name)}"`,
    },
  });

  try {
    // Explicit identifiers only: never forward the PDF object or its bytes.
    await dependencies.audit({ ...event, pdfId: file.id });
  } catch (error) {
    dependencies.logError("signed_pdf_download_audit", error);
  }
  return response;
}
