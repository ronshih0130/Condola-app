import type { Metadata } from "next";
import terms from "../../../content/legal/terms.md";
import { LegalDocument } from "@/components/legal-document";
import { legalTitle } from "@/server/legal";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: { absolute: legalTitle(terms) },
};

export default function TermsPage() {
  return <LegalDocument markdown={terms} />;
}
