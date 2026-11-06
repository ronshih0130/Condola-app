"use server";
import { requireCurrentConsent } from "./consent-gate";
import { getSession } from "./session";
import { recordStatementVersion, recordReportDelivery, type RecordStatementVersionInput } from "./owner-net-ledger";
import type { ReportDeliveryInput } from "./report-delivery-adapter";

export async function recordStatementVersionAction(input: RecordStatementVersionInput) {
  await requireCurrentConsent();
  return recordStatementVersion(await getSession(),input);
}
export async function recordReportDeliveryAction(input: ReportDeliveryInput) {
  await requireCurrentConsent();
  return recordReportDelivery(await getSession(),input);
}
