export type ReportDeliveryResult = "accepted" | "delivered" | "failed" | "bounced";
export type ReportDeliveryInput = { statementId: string; versionId: string | null; requestId: string };
export interface ReportDeliveryAdapter {
  deliver(input: ReportDeliveryInput): Promise<ReportDeliveryResult>;
}
/** Local simulation only. No recipient lookup, transport or network access. */
export class MockReportDeliveryAdapter implements ReportDeliveryAdapter {
  async deliver(input: ReportDeliveryInput): Promise<ReportDeliveryResult> {
    void input;
    return "accepted";
  }
}
