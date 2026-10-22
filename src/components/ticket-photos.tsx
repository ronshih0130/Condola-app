"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { PHOTO_HEADER_BYTES, PHOTO_MAX_BYTES, PHOTO_MIMES, normalizePhotoMime, sniffPhotoMime } from "@/server/repair-rules";

type Messages = { size: string; type: string; storage: string; limit: string; generic: string; internal: string };

function messageFor(key: string | undefined, messages: Messages) {
  if (key === "errors.photoSize") return messages.size;
  if (key === "errors.photoType") return messages.type;
  if (key === "errors.photoStorage") return messages.storage;
  if (key === "errors.photoLimit") return messages.limit;
  return messages.generic;
}

/**
 * Sends the original file to a signed upload URL. No canvas, no re-encode.
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
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    setError("");
    if (file.size > PHOTO_MAX_BYTES) {
      setError(messages.size);
      return;
    }
    const header = new Uint8Array(await file.slice(0, PHOTO_HEADER_BYTES).arrayBuffer());
    const sniffed = sniffPhotoMime(header);
    const declared = normalizePhotoMime(file.type);
    if (!sniffed || (file.type !== "" && declared !== sniffed)) {
      setError(messages.type);
      return;
    }
    setPending(true);
    try {
      const signed = await fetch(signPath, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ticketId, fileName: file.name, mime: sniffed, size: file.size, ...extra }),
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
      const headers: Record<string, string> = { "content-type": sniffed };
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
          fileName: file.name,
          mime: sniffed,
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
        </label>
      ) : null}
      <input
        className="inp"
        type="file"
        accept={PHOTO_MIMES.join(",")}
        data-testid={inputTestId}
        onChange={onChange}
        disabled={pending}
      />
      {error ? (
        <div className="alert bad" data-testid="repair-photo-error">
          {error}
        </div>
      ) : null}
    </div>
  );
}
