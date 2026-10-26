"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { heicFileToJpeg } from "@/lib/heic-browser";
import { PHOTO_HEADER_BYTES, PHOTO_MAX_BYTES, PHOTO_MIMES, normalizePhotoMime, sniffHeic, sniffPhotoMime } from "@/server/repair-rules";

type Messages = {
  size: string;
  type: string;
  heic: string;
  storage: string;
  limit: string;
  generic: string;
  internal: string;
  internalHint?: string;
  wait?: string;
  failed?: string;
};

function photoFailed(messages: Messages, name: string, fallback: string) {
  if (!messages.failed) return fallback;
  return messages.failed.replaceAll("{name}", name);
}

function messageFor(key: string | undefined, messages: Messages) {
  if (key === "errors.photoSize") return messages.size;
  if (key === "errors.photoType") return messages.type;
  if (key === "errors.photoHeic") return messages.heic;
  if (key === "errors.photoStorage") return messages.storage;
  if (key === "errors.photoLimit") return messages.limit;
  return messages.generic;
}

/**
 * Converts HEIC in the browser, then sends JPEG, PNG, or WEBP to a signed URL.
 */
export function TicketPhotoUpload({
  ticketId,
  label,
  hint,
  allowInternal,
  messages,
  signPath = "/api/tickets/photos/sign",
  confirmPath = "/api/tickets/photos/confirm",
  extra,
  inputTestId = "repair-photo",
}: {
  ticketId: string;
  label: string;
  hint: string;
  allowInternal: boolean;
  messages: Messages;
  signPath?: string;
  confirmPath?: string;
  extra?: Record<string, string>;
  inputTestId?: string;
}) {
  const router = useRouter();
  const internalRef = useRef<HTMLInputElement>(null);
  const [error, setError] = useState("");
  const [pending, setPending] = useState(false);

  async function onChange(event: React.ChangeEvent<HTMLInputElement>) {
    let file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    setError("");
    setPending(true);
    try {
      const header = new Uint8Array(await file.slice(0, PHOTO_HEADER_BYTES).arrayBuffer());
      const heic = sniffHeic(header) || /\.(heic|heif)$/i.test(file.name) || /^image\/hei[cf]$/i.test(file.type);
      if (heic) {
        try {
          file = await heicFileToJpeg(file);
          const convertedHeader = new Uint8Array(await file.slice(0, PHOTO_HEADER_BYTES).arrayBuffer());
          if (sniffPhotoMime(convertedHeader) !== "image/jpeg" || file.size <= 0 || file.size > PHOTO_MAX_BYTES) {
            throw new Error("HEIC conversion did not produce an accepted JPEG");
          }
        } catch {
          setError(messages.heic);
          return;
        }
      }
      if (file.size <= 0 || file.size > PHOTO_MAX_BYTES) {
        setError(photoFailed(messages, file.name, messages.size));
        return;
      }
      const uploadHeader = new Uint8Array(await file.slice(0, PHOTO_HEADER_BYTES).arrayBuffer());
      const mime = sniffPhotoMime(uploadHeader);
      const declared = normalizePhotoMime(file.type);
      if (!mime || (file.type !== "" && declared !== mime)) {
        setError(photoFailed(messages, file.name, messages.type));
        return;
      }
      const fileName = file.name;
      const signed = await fetch(signPath, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ticketId, fileName, mime, size: file.size, ...extra }),
      });
      const signBody = (await signed.json()) as {
        error?: string;
        uploadUrl?: string;
        token?: string;
        path?: string;
        uploadToken?: string;
      };
      if (!signed.ok || !signBody.uploadUrl || !signBody.path || !signBody.uploadToken) {
        setError(messageFor(signBody.error, messages));
        return;
      }
      const headers: Record<string, string> = { "content-type": mime };
      if (signBody.token) headers.authorization = `Bearer ${signBody.token}`;
      const uploaded = await fetch(signBody.uploadUrl, { method: "PUT", headers, body: file });
      if (!uploaded.ok) {
        setError(messages.storage);
        return;
      }
      const confirmed = await fetch(confirmPath, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          ticketId,
          path: signBody.path,
          fileName,
          mime,
          size: file.size,
          internal: Boolean(allowInternal && internalRef.current?.checked),
          uploadToken: signBody.uploadToken,
          ...extra,
        }),
      });
      const confirmedBody = (await confirmed.json()) as { error?: string };
      if (!confirmed.ok) {
        setError(messageFor(confirmedBody.error, messages));
        return;
      }
      if (internalRef.current) internalRef.current.checked = false;
      router.refresh();
    } catch {
      setError(messages.generic);
    } finally {
      setPending(false);
    }
  }

  return (
    <div>
      <label className="f">{label}</label>
      <p className="tiny muted">{hint}</p>
      {allowInternal ? (
        <label className="small">
          <input ref={internalRef} type="checkbox" /> {messages.internal}
          {messages.internalHint ? <div className="tiny muted">{messages.internalHint}</div> : null}
        </label>
      ) : null}
      <input
        className="inp"
        type="file"
        accept={`${PHOTO_MIMES.join(",")},.heic,.heif,image/heic,image/heif`}
        data-testid={inputTestId}
        onChange={onChange}
        disabled={pending}
      />
      {pending && messages.wait ? <p className="tiny">{messages.wait}</p> : null}
      {error ? (
        <div className="alert bad" data-testid="repair-photo-error">
          {error}
        </div>
      ) : null}
    </div>
  );
}
