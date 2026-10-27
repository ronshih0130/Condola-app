import { LegalDocument } from "@/components/legal-document";
import { partnerBundledText } from "@/server/partner-consent-bundle";
import { partnerDocumentConfig, parsePartnerDocumentConfig } from "@/server/partner-consent-rules";

export const dynamic = "force-dynamic";

export default async function PartnerAgreementPage({
  searchParams,
}: { searchParams: Promise<{ locale?: string }> }) {
  const params = await searchParams;
  const config = parsePartnerDocumentConfig(partnerDocumentConfig);
  const entries = config.documents.partner_agreement;
  const entry = entries.find((doc) => doc.locale === params.locale)
    ?? entries.find((doc) => doc.locale === config.default_locale)!;
  return <LegalDocument markdown={partnerBundledText(entry.source)} />;
}
