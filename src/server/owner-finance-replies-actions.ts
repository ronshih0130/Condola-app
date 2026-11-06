"use server";
import { requireCurrentConsent } from "./consent-gate";
import { getSession } from "./session";
import { saveReceiptTitle, recordReportReply, type SaveReceiptTitleInput, type RecordReportReplyInput } from "./owner-finance-replies";

export async function saveReceiptTitleAction(input: SaveReceiptTitleInput) {
  await requireCurrentConsent();
  return saveReceiptTitle(await getSession(),input);
}
export async function recordReportReplyAction(input: RecordReportReplyInput) {
  await requireCurrentConsent();
  return recordReportReply(await getSession(),input);
}
