"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { errorText } from "@/i18n/errors";
import { REPAIR_CAT_KEY } from "@/lib/repair-labels";
import { PHOTO_HEADER_BYTES, PHOTO_MAX_BYTES, PHOTO_MIMES, normalizePhotoMime, sniffPhotoMime } from "@/server/repair-rules";
import { useT } from "./locale";

type LeaseOption = { id: string; label: string };
type Cat = { value: string; label: string };

async function uploadPhoto(ticketId: string, file: File) {
  const signed = await fetch("/api/tickets/photos/sign", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ ticketId, fileName: file.name, mime: sniffPhotoMime(new Uint8Array(await file.slice(0, PHOTO_HEADER_BYTES).arrayBuffer())), size: file.size }),
  });
  const signBody = (await signed.json()) as { uploadUrl?: string; token?: string; path?: string; uploadToken?: string };
  if (!signed.ok || !signBody.uploadUrl || !signBody.path || !signBody.uploadToken) return false;
  const header = new Uint8Array(await file.slice(0, PHOTO_HEADER_BYTES).arrayBuffer());
  const sniffed = sniffPhotoMime(header);
  if (!sniffed) return false;
  const headers: Record<string, string> = { "content-type": sniffed };
  if (signBody.token) headers.authorization = `Bearer ${signBody.token}`;
  const uploaded = await fetch(signBody.uploadUrl, { method: "PUT", headers, body: file });
  if (!uploaded.ok) return false;
  const confirmed = await fetch("/api/tickets/photos/confirm", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      ticketId,
      path: signBody.path,
      fileName: file.name,
      mime: sniffed,
      size: file.size,
      internal: false,
      uploadToken: signBody.uploadToken,
    }),
  });
  return confirmed.ok;
}

export function RepairCreateForm({
  leases,
  leaseId,
  categories,
  returnTo,
  disabled,
  denied,
  submitTestId,
}: {
  leases?: LeaseOption[];
  leaseId?: string;
  categories: Cat[];
  returnTo: "staff" | "tenant";
  disabled?: boolean;
  denied?: string;
  submitTestId: string;
}) {
  const t = useT();
  const router = useRouter();
  const [error, setError] = useState("");
  const [pending, setPending] = useState(false);
  const [names, setNames] = useState<string[]>([]);
  const [files, setFiles] = useState<File[]>([]);

  function onPhotos(list: FileList | null) {
    const next: File[] = [];
    const labels: string[] = [];
    for (const file of Array.from(list ?? [])) {
      if (next.length >= 8) break;
      next.push(file);
      labels.push(file.name);
    }
    setFiles(next);
    setNames(labels);
  }

  async function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (disabled || pending) return;
    const data = new FormData(event.currentTarget);
    setError("");
    const picked = files;
    for (const file of picked) {
      if (file.size > PHOTO_MAX_BYTES) {
        setError(t("i_photo_size"));
        return;
      }
      const header = new Uint8Array(await file.slice(0, PHOTO_HEADER_BYTES).arrayBuffer());
      const sniffed = sniffPhotoMime(header);
      const declared = normalizePhotoMime(file.type);
      if (!sniffed || (file.type !== "" && declared !== sniffed)) {
        setError(t("i_photo_type"));
        return;
      }
    }
    setPending(true);
    try {
      const created = await fetch("/api/tickets", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          leaseId: leaseId || String(data.get("leaseId") ?? ""),
          category: String(data.get("category") ?? ""),
          title: String(data.get("title") ?? ""),
          description: String(data.get("description") ?? ""),
          returnTo,
        }),
      });
      const body = (await created.json()) as { error?: string; id?: string; next?: string };
      if (!created.ok || !body.id || !body.next) {
        setError(errorText(t, body.error));
        setPending(false);
        return;
      }
      let photoFailed = false;
      for (const file of picked) {
        try {
          const ok = await uploadPhoto(body.id, file);
          if (!ok) photoFailed = true;
        } catch {
          photoFailed = true;
        }
      }
      const next = new URL(body.next, window.location.origin);
      if (photoFailed) next.searchParams.set("photoError", "1");
      router.push(`${next.pathname}${next.search}`);
      router.refresh();
    } catch {
      setError(t("i_generic"));
      setPending(false);
    }
  }

  return (
    <form className={returnTo === "staff" ? "card pad" : undefined} data-testid="repair-create-form" onSubmit={onSubmit}>
      {error ? (
        <div className="alert bad" data-testid="repair-create-error">
          {error}
        </div>
      ) : null}
      {leaseId ? <input type="hidden" name="leaseId" value={leaseId} /> : null}
      {leases ? (
        <div className="fg">
          <label className="f">{t("i_select_lease")}</label>
          <select className="inp" name="leaseId" defaultValue="" disabled={disabled}>
            <option value="">{t("i_choose")}</option>
            {leases.map((lease) => (
              <option key={lease.id} value={lease.id}>
                {lease.label}
              </option>
            ))}
          </select>
        </div>
      ) : null}
      <div className="fg">
        <label className="f">{t("i_category")}</label>
        <select className="inp" name="category" data-testid="repair-category" defaultValue="" disabled={disabled}>
          <option value="">{t("i_choose")}</option>
          {categories.map((cat) => (
            <option key={cat.value} value={cat.value}>
              {cat.label || t(REPAIR_CAT_KEY[cat.value] ?? "i_cat_other")}
            </option>
          ))}
        </select>
      </div>
      <div className="fg">
        <label className="f">{t("i_title")}</label>
        <input className="inp" name="title" data-testid="repair-title" placeholder={t("i_ph_title")} defaultValue="" disabled={disabled} />
      </div>
      <div className="fg">
        <label className="f">{t("i_description")}</label>
        <textarea className="inp" name="description" defaultValue="" disabled={disabled} />
      </div>
      <div className="fg">
        <label className="f">{t("i_repair_photo_create")}</label>
        <p className="tiny muted">{t("i_repair_photo_hint")}</p>
        <input
          className="inp"
          type="file"
          accept={PHOTO_MIMES.join(",")}
          multiple
          data-testid="repair-create-photo"
          disabled={disabled}
          onChange={(event) => onPhotos(event.target.files)}
        />
        {names.length ? <p className="small muted">{names.join(t("i_list_sep"))}</p> : null}
      </div>
      <button
        className={returnTo === "tenant" ? "btn pri block" : "btn pri"}
        type="submit"
        disabled={disabled || pending}
        aria-disabled={disabled || pending ? true : undefined}
        title={disabled ? denied : undefined}
        data-testid={submitTestId}
      >
        {t("i_submit_repair")}
      </button>
      {disabled && denied ? <p className="tiny muted">{denied}</p> : null}
    </form>
  );
}
