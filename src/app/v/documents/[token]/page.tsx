import { notFound } from "next/navigation";
import { VendorDocumentsPanel, type VendorDocumentsView } from "@/components/vendor-documents-panel";
import { vendorDocumentContext } from "@/server/vendor-documents-gate";

export const dynamic = "force-dynamic";

/** B-025 vendor document entry by document-grant token. Flag OFF / invalid token ⇒ 404. */
export default async function VendorDocumentsPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const context = await vendorDocumentContext(token).catch(() => null);
  if (!context) notFound();
  return <VendorDocumentsPanel token={token} initial={context as unknown as VendorDocumentsView} locale="zh-TW" />;
}
