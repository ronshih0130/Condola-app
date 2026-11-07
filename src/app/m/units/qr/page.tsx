import { notFound } from "next/navigation";
import { UnitQrControl } from "@/components/unit-qr-control";
import { unitQrCopy } from "@/i18n/lanes/unit-qr";
import { requireCurrentConsent } from "@/server/consent-gate";
import { getSession } from "@/server/session";
import { unitQrStaffUnits } from "@/server/unit-qr-signup";

export const dynamic = "force-dynamic";
export default async function UnitQrPage() {
  await requireCurrentConsent();
  const session = await getSession();
  const units = await unitQrStaffUnits(session);
  if (!units) notFound();
  return <div className="card pad"><h1>{unitQrCopy(session.locale).title}</h1><UnitQrControl units={units} locale={session.locale} /></div>;
}
