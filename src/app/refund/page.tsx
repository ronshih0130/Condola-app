import type { Metadata } from "next";
import refund from "../../../content/legal/refund.md";
import { LegalDocument } from "@/components/legal-document";
import { legalTitle } from "@/server/legal";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: { absolute: legalTitle(refund) },
};

export default function RefundPage() {
  return <LegalDocument markdown={refund} />;
}
