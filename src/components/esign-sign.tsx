"use client";

import { useRouter } from "next/navigation";
import EsignSignatureCanvas from "./esign-signature-canvas";
import { actionEsignSign } from "@/server/esign/actions";

export function EsignSign({ caseId, versionId, digest, locale }: {
  caseId: string; versionId: string; digest: string; locale: "zh-TW" | "en";
}) {
  const router = useRouter();
  return <div style={{ padding: 2, minWidth: 0 }}><EsignSignatureCanvas locale={locale} onSubmit={async ({ strokes }) => {
    await actionEsignSign({ caseId, versionId, digest, strokes });
    router.refresh();
  }} /></div>;
}
