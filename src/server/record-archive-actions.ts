"use server";
import { sameArchiveScope, type ArchiveCommandInput, type ArchiveRef, type RenderedArchiveScope } from "@/lib/record-archive";
import { requireCurrentConsent } from "./consent-gate";
import { getSession } from "./session";
import { archiveCommand, archiveScope, archiveView } from "./record-archive";
export async function archiveCommandAction(input:ArchiveCommandInput) { await requireCurrentConsent(); return archiveCommand(await getSession(),input); }
export async function archiveViewAction(ref:ArchiveRef,expectedScope?:RenderedArchiveScope) { await requireCurrentConsent();const session=await getSession();if(expectedScope!==undefined&&!sameArchiveScope(expectedScope,archiveScope(session)))return {state:'unavailable' as const};return archiveView(session,ref); }
