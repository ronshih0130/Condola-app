import { LegacyPaymentsList } from "@/components/legacy-payments-list";
import { requireCurrentConsent } from "@/server/consent-gate";
import { getSession } from "@/server/session";

export const dynamic = "force-dynamic";

export default async function PaymentsListPage({ searchParams }: { searchParams: Promise<{ error?: string }> }) {
  await requireCurrentConsent(undefined, "page");
  const session = await getSession();
  const params = await searchParams;
  return LegacyPaymentsList({ session, error: params.error, returnTo: "/m/payments/list" });
}
