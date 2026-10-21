"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";

const MAX_BYTES = 5 * 1024 * 1024;
const ALLOWED = ["image/jpeg", "image/png", "image/webp", "image/gif"];

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
}: {
  ticketId: string;
  label: string;
  hint: string;
  allowInternal: boolean;
  messages: Messages;
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
    if (file.size > MAX_BYTES) {
      setError(messages.size);
      return;
    }
    if (!ALLOWED.includes(file.type)) {
      setError(messages.type);
      return;
    }
    setPending(true);
    try {
      const signed = await fetch("/api/tickets/photos/sign", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ticketId, fileName: file.name, mime: file.type, size: file.size }),
      });
      const signBody = (await signed.json()) as { error?: string; uploadUrl?: string; token?: string; path?: string };
      if (!signed.ok || !signBody.uploadUrl || !signBody.path) {
        setError(messageFor(signBody.error, messages));
        return;
      }
      const headers: Record<string, string> = { "content-type": file.type };
      if (signBody.token) headers.authorization = `Bearer ${signBody.token}`;
      const uploaded = await fetch(signBody.uploadUrl, { method: "PUT", headers, body: file });
      if (!uploaded.ok) {
        setError(messages.storage);
        return;
      }
      const confirmed = await fetch("/api/tickets/photos/confirm", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          ticketId,
          path: signBody.path,
          fileName: file.name,
          mime: file.type,
          size: file.size,
          internal: Boolean(allowInternal && internalRef.current?.checked),
        }),
      });
      const confirmBody = (await confirmed.json()) as { error?: string };
      if (!confirmed.ok) {
        setError(messageFor(confirmBody.error, messages));
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
        accept="image/jpeg,image/png,image/webp,image/gif"
        data-testid="repair-photo"
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
