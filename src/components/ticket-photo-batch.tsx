"use client";

import { useId, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { heicFileToJpeg } from "@/lib/heic-browser";
import { PHOTO_HEADER_BYTES, PHOTO_MAX_BYTES, PHOTO_MIMES, normalizePhotoMime, sniffHeic, sniffPhotoMime } from "@/server/repair-rules";
import type { UploadRecoveryCopy } from "@/i18n/upload-recovery";
import type { UploadRecoveryDraft } from "@/lib/upload-recovery-types";

type Messages = {
  size: string;
  type: string;
  heic: string;
  storage: string;
  limit: string;
  generic: string;
  internal: string;
  internalHint?: string;
  failed?: string;
};

type Status = "queued" | "uploading" | "uploaded" | "failed" | "attached";
type Item = { clientKey: string; name: string; status: Status; error?: string; file?: File; mime?: string };

const BATCH_PATH = "/api/tickets/photos/batch";

function messageFor(key: string | undefined, messages: Messages) {
  if (key === "errors.photoSize") return messages.size;
  if (key === "errors.photoType") return messages.type;
  if (key === "errors.photoHeic") return messages.heic;
  if (key === "errors.photoStorage") return messages.storage;
  if (key === "errors.photoLimit") return messages.limit;
  return messages.generic;
}

function fromDraft(draft: UploadRecoveryDraft | null, copy: UploadRecoveryCopy): Item[] {
  return (draft?.items ?? []).map((item) => ({
    clientKey: item.clientKey,
    name: item.name,
    status: item.state === "signed" ? "failed" : item.state,
    error: item.state === "signed" ? copy.reselect : undefined,
  }));
}

/** Browser checks shared with the single-photo uploader: HEIC → JPEG, size, signature. */
async function preparedFile(input: File, messages: Messages): Promise<{ file: File; mime: string } | { error: string }> {
  let file = input;
  const header = new Uint8Array(await file.slice(0, PHOTO_HEADER_BYTES).arrayBuffer());
  const heic = sniffHeic(header) || /\.(heic|heif)$/i.test(file.name) || /^image\/hei[cf]$/i.test(file.type);
  if (heic) {
    try {
      file = await heicFileToJpeg(file);
      const converted = new Uint8Array(await file.slice(0, PHOTO_HEADER_BYTES).arrayBuffer());
      if (sniffPhotoMime(converted) !== "image/jpeg" || file.size <= 0 || file.size > PHOTO_MAX_BYTES) throw new Error("HEIC conversion");
    } catch {
      return { error: messages.heic };
    }
  }
  if (file.size <= 0 || file.size > PHOTO_MAX_BYTES) return { error: messages.size };
  const mime = sniffPhotoMime(new Uint8Array(await file.slice(0, PHOTO_HEADER_BYTES).arrayBuffer()));
  if (!mime || (file.type !== "" && normalizePhotoMime(file.type) !== mime)) return { error: messages.type };
  return { file, mime };
}

async function post(body: Record<string, unknown>) {
  const response = await fetch(BATCH_PATH, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const payload = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  return { ok: response.ok && payload.ok === true, payload };
}

/**
 * B-031 UPLOAD_RECOVERY (flag ON only). Several photos per selection, each with a
 * random client key. A retry re-sends only failed files under the same key, so an
 * already-uploaded file is recognised by the server and never stored or attached twice.
 * Keys live in memory only; nothing is written to browser storage.
 */
export function TicketPhotoBatchUpload({
  ticketId,
  label,
  chooseLabel,
  hint,
  allowInternal,
  messages,
  copy,
  draft,
}: {
  ticketId: string;
  label: string;
  chooseLabel: string;
  hint: string;
  allowInternal: boolean;
  messages: Messages;
  copy: UploadRecoveryCopy;
  draft: UploadRecoveryDraft | null;
}) {
  const router = useRouter();
  const uploadId = useId();
  const batchKey = useRef(draft?.batchKey ?? crypto.randomUUID());
  const [internal, setInternal] = useState(Boolean(allowInternal && draft?.internal));
  const [items, setItems] = useState<Item[]>(() => fromDraft(draft, copy));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [done, setDone] = useState(false);

  function update(clientKey: string, patch: Partial<Item>) {
    setItems((current) => current.map((item) => (item.clientKey === clientKey ? { ...item, ...patch } : item)));
  }

  function errorText(key: unknown) {
    if (key === "errors.busy") return copy.busy;
    return messageFor(typeof key === "string" ? key : undefined, messages);
  }

  /**
   * The server says this draft is already closed (e.g. the submit committed but its
   * response was lost, or another tab discarded it). Start a new draft key; drop rows
   * that no longer exist server-side and show the ticket's real photos via refresh.
   */
  function startNewDraft() {
    batchKey.current = crypto.randomUUID();
    setItems((current) => current.filter((item) => item.file && item.status !== "uploaded" && item.status !== "attached"));
    router.refresh();
  }

  async function send(item: Item, rotated = false) {
    if (!item.file || !item.mime) return;
    update(item.clientKey, { status: "uploading", error: undefined });
    try {
      const base = { ticketId, batchKey: batchKey.current, clientKey: item.clientKey };
      const prepared = await post({ op: "prepare", ...base, fileName: item.name, mime: item.mime, size: item.file.size, internal });
      if (!prepared.ok) {
        update(item.clientKey, { status: "failed", error: errorText(prepared.payload.error) });
        return;
      }
      const state = prepared.payload.state;
      if (state === "closed") {
        if (rotated) {
          update(item.clientKey, { status: "failed", error: messages.generic });
          return;
        }
        startNewDraft();
        await send(item, true);
        return;
      }
      if (state === "uploaded" || state === "attached") {
        update(item.clientKey, { status: state });
        return;
      }
      if (state === "signed") {
        const headers: Record<string, string> = { "content-type": item.mime };
        if (prepared.payload.token) headers.authorization = `Bearer ${String(prepared.payload.token)}`;
        const stored = await fetch(String(prepared.payload.uploadUrl), { method: "PUT", headers, body: item.file });
        if (!stored.ok) {
          update(item.clientKey, { status: "failed", error: messages.storage });
          return;
        }
      }
      const confirmed = await post({ op: "confirm", ...base });
      if (!confirmed.ok || confirmed.payload.state === "missing") {
        update(item.clientKey, { status: "failed", error: errorText(confirmed.payload.error) });
        return;
      }
      update(item.clientKey, { status: confirmed.payload.state === "attached" ? "attached" : "uploaded" });
    } catch {
      update(item.clientKey, { status: "failed", error: messages.storage });
    }
  }

  async function run(queue: Item[]) {
    setBusy(true);
    setError("");
    try {
      for (const item of queue) await send(item);
    } finally {
      setBusy(false);
    }
  }

  async function onChange(event: React.ChangeEvent<HTMLInputElement>) {
    const files = Array.from(event.target.files ?? []);
    event.target.value = "";
    if (!files.length) return;
    setDone(false);
    const added: Item[] = [];
    for (const original of files) {
      const clientKey = crypto.randomUUID();
      const checked = await preparedFile(original, messages);
      added.push("error" in checked
        ? { clientKey, name: original.name, status: "failed", error: checked.error }
        : { clientKey, name: checked.file.name, status: "queued", file: checked.file, mime: checked.mime });
    }
    setItems((current) => [...current, ...added]);
    await run(added.filter((item) => item.status === "queued"));
  }

  async function retryFailed() {
    const failed = items.filter((item) => item.status === "failed" && item.file && item.mime);
    if (failed.length) await run(failed);
  }

  async function submit() {
    setBusy(true);
    setError("");
    try {
      // A lost response is safe to repeat: a closed draft replays the same attachments.
      const result = await post({ op: "submit", ticketId, batchKey: batchKey.current, internal });
      if (!result.ok) {
        setError(result.payload.error === "errors.photoLimit" ? copy.trim : errorText(result.payload.error));
        return;
      }
      batchKey.current = crypto.randomUUID();
      setItems([]);
      setInternal(false);
      setDone(true);
      router.refresh();
    } catch {
      setError(messages.generic);
    } finally {
      setBusy(false);
    }
  }

  /** Remove one file (clientKey) or discard the whole draft, server-side first. */
  async function discard(clientKey?: string) {
    setBusy(true);
    setError("");
    try {
      const result = await post({ op: clientKey ? "remove" : "discard", ticketId, batchKey: batchKey.current, clientKey });
      if (!result.ok) {
        setError(errorText(result.payload.error));
        return;
      }
      if (!clientKey || result.payload.state === "closed") {
        batchKey.current = crypto.randomUUID();
        setItems(clientKey ? (current) => current.filter((item) => item.file && item.status !== "uploaded" && item.status !== "attached" && item.clientKey !== clientKey) : []);
        router.refresh();
        return;
      }
      setItems((current) => current.filter((item) => item.clientKey !== clientKey));
    } catch {
      setError(messages.generic);
    } finally {
      setBusy(false);
    }
  }

  const uploaded = items.filter((item) => item.status === "uploaded").length;
  const removable = items.some((item) => item.status !== "attached");
  const restoredKept = Boolean(draft?.items.some((item) => item.state === "uploaded"));
  const retryable = items.some((item) => item.status === "failed" && item.file);
  const failedCount = items.filter((item) => item.status === "failed").length;
  const statusText: Record<Status, string> = {
    queued: copy.queued,
    uploading: copy.uploading,
    uploaded: copy.uploaded,
    failed: copy.failed,
    attached: copy.attached,
  };

  return (
    <div data-testid="repair-photo-batch">
      <h4 className="ticket-photo-heading">{label}</h4>
      <p className="tiny muted" id={`${uploadId}-hint`}>{hint}</p>
      {restoredKept ? <p className="tiny" data-testid="repair-photo-restored">{copy.restored}</p> : null}
      {allowInternal ? (
        <label className="small">
          <input type="checkbox" checked={internal} disabled={busy} onChange={(event) => setInternal(event.target.checked)} /> {messages.internal}
          {messages.internalHint ? <div className="tiny muted">{messages.internalHint}</div> : null}
        </label>
      ) : null}
      <label className="btn ticket-photo-choose" aria-disabled={busy}>
        {chooseLabel}
        <input
          className="ticket-photo-file"
          type="file"
          multiple
          accept={`${PHOTO_MIMES.join(",")},.heic,.heif,image/heic,image/heif`}
          aria-describedby={`${uploadId}-hint`}
          data-testid="repair-photo"
          onChange={onChange}
          disabled={busy}
        />
      </label>
      {items.length ? (
        <ul className="small" aria-label={copy.list} aria-live="polite" data-testid="repair-photo-status">
          {items.map((item) => (
            <li key={item.clientKey} data-status={item.status}>
              {item.name} · {statusText[item.status]}
              {item.error ? <span className="tiny muted"> · {item.error}</span> : null}
              {item.status === "failed" || item.status === "uploaded" ? (
                <>
                  {" "}
                  <button className="btn sm" type="button" disabled={busy} onClick={() => discard(item.clientKey)} data-testid="repair-photo-remove">
                    {copy.remove}
                  </button>
                </>
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}
      {failedCount && uploaded ? <p className="tiny muted">{copy.leftOut}</p> : null}
      <div className="fg">
        {retryable ? (
          <button className="btn sm" type="button" disabled={busy} onClick={retryFailed} data-testid="repair-photo-retry">
            {copy.retry}
          </button>
        ) : null}
        {uploaded ? (
          <button className="btn pri sm" type="button" disabled={busy} onClick={submit} data-testid="repair-photo-submit">
            {busy ? copy.submitting : copy.submit.replaceAll("{count}", String(uploaded))}
          </button>
        ) : null}
        {removable ? (
          <button className="btn sm" type="button" disabled={busy} onClick={() => discard()} data-testid="repair-photo-discard">
            {copy.discard}
          </button>
        ) : null}
      </div>
      {done ? <p className="tiny" role="status">{copy.submitted}</p> : null}
      {error ? (
        <div className="alert bad" data-testid="repair-photo-error" role="alert">
          {error}
        </div>
      ) : null}
    </div>
  );
}
