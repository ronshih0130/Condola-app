import type { PdfDocument } from "@/lib/pdf-document";
import { COPY, majorOf, nt, periodRentLabel } from "./lease-lifecycle-rules";
import type { SettlementView } from "./lease-lifecycle";

export function buildSettlementPdf(view: SettlementView, tenant: string): PdfDocument {
  const money = (minor: number) => nt(majorOf(minor, view.currency));
  return {
    filename: "deposit-settlement.pdf",
    title: `${COPY.settle}：${tenant}`,
    subtitle: view.moveOutOn,
    blocks: [
      {
        kind: "rows",
        heading: COPY.depositSection,
        rows: [
          { label: COPY.depositHeld, value: money(view.depositMinor) },
          ...view.lines.map((line) => ({ label: line.label, value: money(line.amountMinor) })),
          { label: periodRentLabel(view.moveOutOn), value: money(view.finalRentMinor) },
          { label: COPY.ownerRefundDone, value: money(view.refundMinor) },
        ],
      },
      { kind: "text", heading: "", lines: [COPY.disclaimer] },
    ],
    footerLabel: COPY.disclaimer,
    footerHash: view.moveOutOn,
  };
}
