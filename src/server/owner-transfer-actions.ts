"use server";
import { requireCurrentConsent } from "./consent-gate";
import { getSession } from "./session";
import { recordOwnerTransfer, reverseOwnerTransfer } from "./owner-transfers";
import type { TransferInput, ReverseInput } from "./owner-transfer-input";
export async function recordOwnerTransferAction(input:TransferInput) { await requireCurrentConsent();return recordOwnerTransfer(await getSession(),input); }
export async function reverseOwnerTransferAction(input:ReverseInput) { await requireCurrentConsent();return reverseOwnerTransfer(await getSession(),input); }
