import { MoneyMonthPage } from "@/components/v3/m/money/page";
import { LegacyPaymentsList } from "@/components/legacy-payments-list";
import type { MoneyParams } from "@/server/money-page";
import { brandV3EnabledForOrg } from "@/server/brand-v3";
import { requireCurrentConsent } from "@/server/consent-gate";
import { getSession } from "@/server/session";

export const dynamic = "force-dynamic";

export default async function PaymentsPage({ searchParams }: { searchParams: Promise<MoneyParams> }) {
  await requireCurrentConsent(undefined, "page");
  const session = await getSession();
  const v3 = await brandV3EnabledForOrg(session.orgId);
  const params = await searchParams;
  if (v3) return <MoneyMonthPage session={session} params={params} />;
  return LegacyPaymentsList({ session, error: params.error });
}
