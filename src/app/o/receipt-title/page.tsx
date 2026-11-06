import { notFound } from "next/navigation";
import { requireCurrentConsent } from "@/server/consent-gate";
import { ReceiptTitleForm } from "@/components/receipt-title-form";
import { ownerReceiptTitleView } from "@/server/owner-finance-replies";
import { getSession } from "@/server/session";

export const dynamic = "force-dynamic";

/** B-022 owner-entered receipt title. Flag OFF (owner_receipt_title) ⇒ 404, no reads beyond the flag. */
export default async function OwnerReceiptTitlePage() {
  await requireCurrentConsent(undefined, "page");
  const session = await getSession();
  const view = await ownerReceiptTitleView(session);
  if (!view) notFound();
  return <ReceiptTitleForm view={view} locale={session.locale} />;
}
