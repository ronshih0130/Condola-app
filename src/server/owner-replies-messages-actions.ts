"use server";
import { requireCurrentConsent } from "./consent-gate";
import { getSession } from "./session";
import { postOwnerMessage, replyOwnerLifecycle, type PostOwnerMessageInput, type ReplyLifecycleInput } from "./owner-replies-messages";

// B-023 slice 2 owner POSTs: Next server actions (same-origin enforced by Next),
// consent-gated first, idempotent by the client-held request id.
export async function replyOwnerLifecycleAction(input: ReplyLifecycleInput) {
  await requireCurrentConsent();
  return replyOwnerLifecycle(await getSession(), input);
}
export async function postOwnerMessageAction(input: PostOwnerMessageInput) {
  await requireCurrentConsent();
  return postOwnerMessage(await getSession(), input);
}
