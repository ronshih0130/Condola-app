"use client";

import { useEffect, useRef, useState } from "react";
import {
  RECEIPT_HEADER_BYTES,
  RECEIPT_MAX_BYTES,
  RECEIPT_MIMES,
  normalizeReceiptMime,
  sniffReceiptMime,
} from "@/server/receipt-rules";
import { useT } from "./locale";

type Ready = { name: string; size: number | null; href: string; claim: boolean };

export function formatReceiptSize(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  const mb = bytes / (1024 * 1024);
  return `${mb >= 10 ? Math.round(mb) : mb.toFixed(1)} MB`;
}

function messageFor(key: string | undefined, messages: { size: string; type: string; storage: string; generic: string }) {
  if (key === "errors.receiptSize") return messages.size;
  if (key === "errors.receiptType") return messages.type;
  if (key === "errors.receiptStorage") return messages.storage;
  return messages.generic;
}

/**
 * One receipt. The drop zone stays visible. A file row shows the uploaded file,
 * the upload progress, or the over-10MB error from the receipt mockup.
 */
export function ReceiptUpload({
  kind,
  existing,
}: {
  kind: "expense" | "payment";
  existing?: { id: string; name: string; size: number | null } | null;
}) {
  const t = useT();
  const rootRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const abortRef = useRef<AbortController | null>(null);
  const [over, setOver] = useState(false);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState(0);
  const [uploadingName, setUploadingName] = useState("");
  const [errorName, setErrorName] = useState("");
  const [errorText, setErrorText] = useState("");
  const [ready, setReady] = useState<Ready | null>(
    existing ? { name: existing.name, size: existing.size, href: `/api/receipts/${existing.id}`, claim: false } : null,
  );
  const [claim, setClaim] = useState<{ path: string; token: string; mime: string; size: number } | null>(null);
  const [cleared, setCleared] = useState(false);
  const messages = {
    size: t("i_receipt_too_big"),
    type: t("i_receipt_type"),
    storage: t("i_receipt_storage"),
    generic: t("i_generic"),
  };

  useEffect(() => {
    const form = rootRef.current?.closest("form");
    if (!form) return;
    const block = (event: Event) => {
      if (!busy) return;
      event.preventDefault();
      event.stopPropagation();
    };
    form.addEventListener("submit", block, true);
    return () => form.removeEventListener("submit", block, true);
  }, [busy]);

  function fail(name: string, message: string) {
    setErrorName(name);
    setErrorText(message);
    setReady(null);
    setClaim(null);
    setBusy(false);
    setUploadingName("");
  }

  function clearRow() {
    abortRef.current?.abort();
    abortRef.current = null;
    setBusy(false);
    setUploadingName("");
    setProgress(0);
    setErrorName("");
    setErrorText("");
    setReady(null);
    setClaim(null);
    setCleared(true);
  }

  async function take(file: File) {
    abortRef.current?.abort();
    setErrorName("");
    setErrorText("");
    setClaim(null);
    if (file.size > RECEIPT_MAX_BYTES) {
      fail(file.name, messages.size);
      return;
    }
    const header = new Uint8Array(await file.slice(0, RECEIPT_HEADER_BYTES).arrayBuffer());
    const sniffed = sniffReceiptMime(header);
    const declared = normalizeReceiptMime(file.type);
    if (!sniffed || (file.type !== "" && declared !== sniffed)) {
      fail(file.name, messages.type);
      return;
    }
    setBusy(true);
    setProgress(1);
    setUploadingName(file.name);
    setReady(null);
    const controller = new AbortController();
    abortRef.current = controller;
    try {
      const signed = await fetch("/api/receipts/sign", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ kind, fileName: file.name, mime: sniffed, size: file.size }),
        signal: controller.signal,
      });
      const signBody = (await signed.json()) as {
        error?: string;
        uploadUrl?: string;
        token?: string;
        path?: string;
        uploadToken?: string;
      };
      if (!signed.ok || !signBody.uploadUrl || !signBody.path || !signBody.uploadToken) {
        fail(file.name, messageFor(signBody.error, messages));
        return;
      }
      await putFile(signBody.uploadUrl, signBody.token ?? "", sniffed, file, setProgress, controller.signal);
      if (controller.signal.aborted) return;
      const href = URL.createObjectURL(file);
      setClaim({ path: signBody.path, token: signBody.uploadToken, mime: sniffed, size: file.size });
      setReady({ name: file.name, size: file.size, href, claim: true });
      setCleared(false);
      setBusy(false);
      setUploadingName("");
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") return;
      if (!controller.signal.aborted) fail(file.name, messages.storage);
    }
  }

  function onFiles(list: FileList | null) {
    const file = list?.[0];
    if (inputRef.current) inputRef.current.value = "";
    if (file) void take(file);
  }

  const showReady = ready && !busy && !errorText;
  return (
    <div ref={rootRef} data-testid="receipt-upload">
      <label className="f">{t("i_receipt_label")}</label>
      <label
        className={`receipt-drop${over ? " on" : ""}`}
        data-testid="receipt-drop"
        onDragOver={(event) => {
          event.preventDefault();
          setOver(true);
        }}
        onDragLeave={() => setOver(false)}
        onDrop={(event) => {
          event.preventDefault();
          setOver(false);
          onFiles(event.dataTransfer.files);
        }}
      >
        <span>📎 {t("i_receipt_drop")}</span>
        <input
          ref={inputRef}
          type="file"
          accept={RECEIPT_MIMES.join(",")}
          data-testid="receipt-file-input"
          onChange={(event) => onFiles(event.target.files)}
        />
      </label>
      {busy ? (
        <div className="receipt-file" data-testid="receipt-uploading">
          <div className="receipt-thumb" aria-hidden>
            {uploadingName.toLowerCase().endsWith(".pdf") ? "📄" : "🧾"}
          </div>
          <div className="receipt-main">
            <div>{uploadingName}</div>
            <div className="receipt-meta">
              <div className="receipt-bar" data-testid="receipt-progress">
                <i style={{ width: `${progress}%` }} />
              </div>
              <span className="hint">{t("i_receipt_uploading", { pct: progress })}</span>
            </div>
          </div>
          <button className="receipt-act" type="button" data-testid="receipt-cancel" onClick={clearRow}>
            {t("i_receipt_cancel")}
          </button>
        </div>
      ) : null}
      {errorText ? (
        <div className="receipt-file bad" data-testid="receipt-error">
          <div className="receipt-thumb" aria-hidden>
            ⚠
          </div>
          <div className="receipt-main">
            <div>{errorName}</div>
            <div className="receipt-err">{errorText}</div>
          </div>
          <button className="receipt-act danger" type="button" data-testid="receipt-remove" onClick={clearRow}>
            {t("i_receipt_remove")}
          </button>
        </div>
      ) : null}
      {showReady ? (
        <div className="receipt-file" data-testid="receipt-file">
          <div className="receipt-thumb" aria-hidden>
            {ready.name.toLowerCase().endsWith(".pdf") ? "📄" : "🧾"}
          </div>
          <div className="receipt-main">
            <div>{ready.name}</div>
            {ready.size != null ? <div className="hint">{formatReceiptSize(ready.size)}</div> : null}
          </div>
          <a className="receipt-act" href={ready.href} target="_blank" rel="noreferrer" data-testid="receipt-view">
            {t("i_receipt_view")}
          </a>
          <button className="receipt-act danger" type="button" data-testid="receipt-remove" onClick={clearRow}>
            {t("i_receipt_remove")}
          </button>
          {ready.claim && claim ? (
            <>
              <input type="hidden" name="receiptPath" value={claim.path} />
              <input type="hidden" name="receiptToken" value={claim.token} />
              <input type="hidden" name="receiptName" value={ready.name} />
              <input type="hidden" name="receiptMime" value={claim.mime} />
              <input type="hidden" name="receiptSize" value={String(claim.size)} />
            </>
          ) : null}
        </div>
      ) : null}
      {cleared ? <input type="hidden" name="receiptClear" value="1" /> : null}
    </div>
  );
}

function putFile(
  url: string,
  token: string,
  mime: string,
  file: File,
  onProgress: (pct: number) => void,
  signal: AbortSignal,
) {
  return new Promise<void>((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    const fail = () => reject(signal.aborted ? new DOMException("Aborted", "AbortError") : new Error("upload"));
    xhr.open("PUT", url);
    xhr.setRequestHeader("content-type", mime);
    if (token) xhr.setRequestHeader("authorization", `Bearer ${token}`);
    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable && event.total > 0) {
        onProgress(Math.max(1, Math.min(99, Math.round((event.loaded / event.total) * 100))));
      }
    };
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        onProgress(100);
        resolve();
      } else fail();
    };
    xhr.onerror = fail;
    xhr.onabort = () => reject(new DOMException("Aborted", "AbortError"));
    signal.addEventListener("abort", () => xhr.abort());
    xhr.send(file);
  });
}
