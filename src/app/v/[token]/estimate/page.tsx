import { randomUUID } from "node:crypto";
import { notFound } from "next/navigation";
import Link from "next/link";
import { FlowError } from "@/server/errors";
import { vendorEstimateContext } from "@/server/vendor-estimates";
import { vendorEstimateCopy as copy } from "@/i18n/vendor-estimates";
import { EstimateForm } from "./estimate-form";
import { TicketPhotoUpload } from "@/components/ticket-photos";
import { makeT } from "@/i18n";
import { requestPrefs } from "@/server/session";

export const dynamic = "force-dynamic";
export default async function VendorEstimatePage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const context = await vendorEstimateContext(token).catch((error: unknown) => {
    const code = (error as { cause?: { code?: string } }).cause?.code;
    if ((error instanceof FlowError && error.key === "errors.forbidden") || code === "42501") notFound();
    throw error;
  });
  if (!context) notFound();
  const prefs = await requestPrefs();
  const t = makeT(prefs.locale);
  return <section className="card pad" style={{ maxWidth: 640, margin: "24px auto" }}>
    <h1>{copy.title}</h1>
    <TicketPhotoUpload ticketId="" label={t("i_repair_photo_add")} chooseLabel={t("i_repair_photo_choose")}
      hint={t("i_repair_photo_hint")} allowInternal={false}
      messages={{ size: t("i_photo_size"), type: t("i_photo_type"), heic: t("i_photo_heic"),
        storage: t("i_photo_storage"), limit: t("i_photo_limit"), generic: t("i_generic"),
        internal: t("i_repair_internal"), wait: t("i_repair_upload_wait"), failed: t("i_repair_photo_failed") }}
      signPath="/api/vendor-jobs/photos/sign" confirmPath="/api/vendor-jobs/photos/confirm" extra={{ token }} />
    <EstimateForm key={context.headId ?? "first"} token={token} requestId={randomUUID()} context={context} />
    <Link href={`/v/${encodeURIComponent(token)}`}>{copy.back}</Link>
  </section>;
}
