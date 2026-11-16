"use client";

import React, { useId, useState } from "react";
import { heicFileToJpeg } from "../../../lib/heic-browser";
import { PHOTO_HEADER_BYTES, PHOTO_MAX_BYTES, PHOTO_MIMES, normalizePhotoMime, sniffHeic, sniffPhotoMime } from "../../../server/repair-rules";

/**
 * RV-PHOTOS solid upload (GS-27). Same browser checks and sign route as the existing vendor upload;
 * the confirm goes to the B-105 route, which tags the set. On a failed save the chosen file is kept and
 * 「再試一次」 sends the same file again (GS-02); the same upload path makes the retry idempotent.
 */
export type CasePhotoMessages = { size: string; type: string; heic: string; limit: string; saveError: string; retry: string };
type Prepared = { file: File; mime: string; signed?: { path: string; uploadToken: string } };

export function VendorCasePhotoUpload({ token, phase, label, messages }: {
  token: string; phase: "before" | "after"; label: string; messages: CasePhotoMessages;
}) {
  const id = useId();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const [kept, setKept] = useState<Prepared | null>(null);

  async function prepare(original: File): Promise<Prepared | string> {
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

  async function send(item: Prepared) {
    setPending(true); setError("");
    try {
      let signed = item.signed;
      if (!signed) {
        const response = await fetch("/api/vendor-jobs/photos/sign", {
          method: "POST", headers: { "content-type": "application/json" },
          body: JSON.stringify({ token, fileName: item.file.name, mime: item.mime, size: item.file.size }),
        });
        const body = (await response.json().catch(() => ({}))) as { error?: string; uploadUrl?: string; token?: string; path?: string; uploadToken?: string };
        if (body.error === "errors.photoLimit") { setKept(null); setError(messages.limit); return; }
        if (!response.ok || !body.uploadUrl || !body.path || !body.uploadToken) throw new Error("sign");
        const headers: Record<string, string> = { "content-type": item.mime };
        if (body.token) headers.authorization = `Bearer ${body.token}`;
        const uploaded = await fetch(body.uploadUrl, { method: "PUT", headers, body: item.file });
        if (!uploaded.ok) throw new Error("upload");
        signed = { path: body.path, uploadToken: body.uploadToken };
        item = { ...item, signed };
      }
      const confirmed = await fetch("/api/vendor-jobs/case-photos/confirm", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ token, phase, path: signed.path, fileName: item.file.name, mime: item.mime, size: item.file.size, uploadToken: signed.uploadToken }),
      });
      if (!confirmed.ok) throw new Error("confirm");
      setKept(null);
      window.location.reload();
    } catch {
      setKept(item);
      setError(messages.saveError);
    } finally {
      setPending(false);
    }
  }

  async function onChange(event: React.ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    const prepared = await prepare(file);
    if (typeof prepared === "string") { setKept(null); setError(prepared); return; }
    await send(prepared);
  }

  return <div className="v-case-upload">
    {error ? <div className="v-case-error" role="alert">
      <p>{error}</p>
      {kept ? <button type="button" className="v-token-secondary" disabled={pending} onClick={() => send(kept)}>{messages.retry}</button> : null}
    </div> : null}
    <input id={`${id}-file`} className="v-case-file" type="file" disabled={pending} data-testid="vendor-case-photo"
      accept={`${PHOTO_MIMES.join(",")},.heic,.heif,image/heic,image/heif`} onChange={onChange} />
    <label className="v-token-primary v-case-block" htmlFor={`${id}-file`} aria-disabled={pending}>{label}</label>
  </div>;
}
