import { notFound } from "next/navigation";
import { VendorDocumentsPanel, type VendorDocumentsView } from "@/components/vendor-documents-panel";
import { vendorDocumentContext } from "@/server/vendor-documents-gate";
import { VendorTokenShell } from "@/components/v3/vendor/token-shell";
import { VendorDocsV3 } from "@/components/v3/vendor/vendor-docs-v3";
import { vendorDocsV3Brand, vendorDocsV3Stage } from "@/server/gs32-vendor-docs";

export const dynamic = "force-dynamic";

/** B-025 vendor document entry by document-grant token. Flag OFF / invalid token ⇒ 404. */
export default async function VendorDocumentsPage({ params, searchParams }: { params: Promise<{ token: string }>; searchParams?: Promise<{ paper?: string; uploaded?: string }> }) {
  const { token } = await params;
  const context = await vendorDocumentContext(token).catch(() => null);
  if (!context) notFound();
  // GS-32 (vendor_docs_v3 + brand_v3): only the drawn states render in 3.0; every other state keeps the B-025 panel.
  const brand = await vendorDocsV3Brand(token);
  const stage = brand ? vendorDocsV3Stage(context) : null;
  if (brand && stage) {
    const query = (await searchParams) ?? {};
    const total = BigInt(context.totalMinor), received = BigInt(context.receivedMinor);
    return <VendorTokenShell locale="zh-TW" context={brand} notificationHref={null} title={brand.ticketTitle} address="" window=""
      status="" reported={false} canReport={false} caseView={<VendorDocsV3 locale="zh-TW" token={token} brand={brand} stage={stage}
        totalMinor={context.totalMinor} remainingMinor={(total > received ? total - received : BigInt(0)).toString()}
        mode={query.paper === "1" && stage.stage === "receipt_evidence" ? "paper" : "view"} uploaded={query.uploaded === "1"} />}>{null}</VendorTokenShell>;
  }
  return <VendorDocumentsPanel token={token} initial={context as unknown as VendorDocumentsView} locale="zh-TW" />;
}
