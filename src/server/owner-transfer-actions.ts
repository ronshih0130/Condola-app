"use server";
import { requireCurrentConsent } from "./consent-gate";
import { getSession } from "./session";
import { recordOwnerTransfer, reverseOwnerTransfer } from "./owner-transfers";
import type { TransferInput, ReverseInput, OwnerTransferScope } from "./owner-transfer-input";
export async function recordOwnerTransferAction(input:TransferInput,scope:OwnerTransferScope) { await requireCurrentConsent();return recordOwnerTransfer(await getSession(),input,scope); }
export async function reverseOwnerTransferAction(input:ReverseInput,scope:OwnerTransferScope) { await requireCurrentConsent();return reverseOwnerTransfer(await getSession(),input,scope); }
