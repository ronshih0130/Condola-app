"use client";

import React, { useId, useState } from "react";
import { createPhotoUploadController, type PreparedPhoto, type UploadOutcome } from "./vendor-case-controller";
import { heicFileToJpeg } from "../../../lib/heic-browser";
import { PHOTO_HEADER_BYTES, PHOTO_MAX_BYTES, PHOTO_MIMES, normalizePhotoMime, sniffHeic, sniffPhotoMime } from "../../../server/repair-rules";

/**
 * RV-PHOTOS solid upload (GS-27). Same browser checks and sign route as the existing vendor upload;
 * the confirm goes to the B-105 route, which tags the set. On a failed save the chosen file is kept and
 * 「再試一次」 sends the same file again (GS-02); the same upload path makes the retry idempotent.
 */
export type CasePhotoMessages = { size: string; type: string; heic: string; limit: string; saveError: string; retry: string };

/** Browser checks before sign (HEIC conversion, size, sniffed type). Returns the error text on refusal. */
export async function preparePhoto(original: File, messages: CasePhotoMessages): Promise<PreparedPhoto | string> {
  let file = original;
  const header = new Uint8Array(await file.slice(0, PHOTO_HEADER_BYTES).arrayBuffer());
  if (sniffHeic(header) || /\.(heic|heif)$/i.test(file.name) || /^image\/hei[cf]$/i.test(file.type)) {
    try {
      file = await heicFileToJpeg(file);
      const converted = new Uint8Array(await file.slice(0, PHOTO_HEADER_BYTES).arrayBuffer());
      if (sniffPhotoMime(converted) !== "image/jpeg" || file.size <= 0 || file.size > PHOTO_MAX_BYTES) return messages.heic;
    } catch {
      return messages.heic;
    }
  }
  if (file.size <= 0 || file.size > PHOTO_MAX_BYTES) return messages.size;
  const mime = sniffPhotoMime(new Uint8Array(await file.slice(0, PHOTO_HEADER_BYTES).arrayBuffer()));
  if (!mime || (file.type !== "" && normalizePhotoMime(file.type) !== mime)) return messages.type;
  return { file, mime };
}

export function VendorCasePhotoUpload({ token, phase, label, messages }: {
  token: string; phase: "before" | "after"; label: string; messages: CasePhotoMessages;
}) {
  const id = useId();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [canRetry, setCanRetry] = useState(false);
  const [controller] = useState(() => createPhotoUploadController({
    fetch: (input, init) => fetch(input, init), reload: () => window.location.reload(), token, phase,
    prepare: file => preparePhoto(file, messages),
  }));

  async function track(work: Promise<UploadOutcome>) {
    setBusy(true); setError(""); setCanRetry(false);
    const outcome = await work;
    setBusy(controller.busy);
    if (outcome === "saved" || outcome === "busy") return;
    if (outcome === "limit") { setError(messages.limit); return; }
    if (outcome === "failed") { setError(messages.saveError); setCanRetry(controller.kept !== null); return; }
    setError(outcome.invalid);
  }

  function onChange(event: React.ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file || controller.busy) return;
    void track(controller.pick(file));
  }

  return <div className="v-case-upload">
    {error ? <div className="v-case-error" role="alert">
      <p>{error}</p>
      {canRetry ? <button type="button" className="v-token-secondary" disabled={busy} onClick={() => void track(controller.retry())}>{messages.retry}</button> : null}
    </div> : null}
    <input id={`${id}-file`} className="v-case-file" type="file" disabled={busy} data-testid="vendor-case-photo"
      accept={`${PHOTO_MIMES.join(",")},.heic,.heif,image/heic,image/heif`} onChange={onChange} />
    <label className="v-token-primary v-case-block" htmlFor={`${id}-file`} aria-disabled={busy}>{label}</label>
  </div>;
}
