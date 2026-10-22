import type { Metadata } from "next";
import privacy from "../../../content/legal/privacy.md";
import { LegalDocument } from "@/components/legal-document";
import { legalTitle } from "@/server/legal";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: { absolute: legalTitle(privacy) },
};

export default function PrivacyPage() {
  return <LegalDocument markdown={privacy} />;
}
