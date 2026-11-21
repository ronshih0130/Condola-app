"use client";

import React, { useId, useRef, useState } from "react";
import type { Locale } from "../../../i18n";
import { vendorAddressCopy } from "../../../i18n/lanes/brand-v3-vendor-address";
import { TW_CITIES, parseTwAddress, validateAddressParts, type AddressParts } from "../../../lib/tw-address";

/**
 * B-112 ven-addr-confirm in the workbench 我的帳號. The one-line 地址 (approved ven-account field) with 儲存; when the
 * line changed, 儲存 opens 「確認地址」 with the split parts. Only the sheet's 儲存 writes; 取消 closes it and keeps
 * the typed line. Only the address is drawn here: name, phone, issuer type, tax id and stamp are B-065.
 */
type Fetch = (input: string, init: RequestInit) => Promise<Response>;
export type SaveOutcome = "saved" | "stale" | "conflict" | "invalid" | "failed" | "busy";

/**
 * One request id per payload: retrying the same parts replays it; any edited parts (or a conflict) get a new id,
 * so a changed payload never reuses an id. Saved or stale (the version moved) reload the page; conflict, invalid
 * and failed keep every input and show the GS-02 failure.
 */
export function createAddressSaver(deps: { fetch: Fetch; reload: () => void; newId?: () => string }) {
  const newId = deps.newId ?? (() => globalThis.crypto.randomUUID());
  let requestId = newId(), payload: string | null = null, busy = false;
  return {
    get busy() { return busy; },
    get requestId() { return requestId; },
    reset() { requestId = newId(); payload = null; },
    async save(expectedVersion: number, parts: AddressParts): Promise<SaveOutcome> {
      if (busy) return "busy";
      const body = JSON.stringify({ expectedVersion, parts });
      if (payload !== null && payload !== body) requestId = newId();
      payload = body;
      busy = true;
      try {
        const response = await deps.fetch("/api/vendor-account/address", {
          method: "POST", headers: { "content-type": "application/json" }, credentials: "same-origin",
          body: JSON.stringify({ requestId, expectedVersion, parts }),
        });
        const result = (await response.json().catch(() => null)) as { status?: string } | null;
        const outcome: SaveOutcome = response.ok && (result?.status === "recorded" || result?.status === "unchanged") ? "saved"
          : result?.status === "rejected_stale" ? "stale"
          : result?.status === "rejected_conflict" ? "conflict"
          : result?.status === "rejected_invalid" ? "invalid" : "failed";
        if (outcome === "saved" || outcome === "stale") deps.reload();
        if (outcome === "conflict") { requestId = newId(); payload = null; }
        return outcome;
      } catch {
        return "failed";
      } finally {
        busy = false;
      }
    },
  };
}

/**
 * The card's flow without React, so its guards are tested directly: 儲存 on an unchanged line does nothing; a changed
 * line opens the sheet with the split parts (a new request); 取消 closes it and keeps the typed line; the sheet's
 * 儲存 validates first (R2-ADDR), ignores a second press while one is in flight, and reports the GS-02 failure.
 */
export function createAddressFlow(deps: { saver: ReturnType<typeof createAddressSaver>; version: number; saved: string | null }) {
  let line = deps.saved ?? "", open = false, parts: AddressParts = { city: "", district: "", street: "", number: "" }, unreadable = false;
  return {
    get line() { return line; }, get open() { return open; }, get parts() { return parts; }, get unreadable() { return unreadable; },
    type(value: string) { line = value; },
    edit(next: AddressParts) { parts = next; },
    confirm() {
      if (line.trim() === (deps.saved ?? "").trim()) return false;
      const parsed = parseTwAddress(line);
      parts = parsed.parts; unreadable = !parsed.ok; open = true;
      deps.saver.reset();
      return true;
    },
    cancel() { open = false; },
    async save(): Promise<SaveOutcome | "invalid_parts"> {
      if (validateAddressParts(parts).length) return "invalid_parts";
      return deps.saver.save(deps.version, parts);
    },
  };
}

export function VendorAddressCard({ locale, version, address, children }: { locale: Locale; version: number; address: string | null; children?: React.ReactNode }) {
  const copy = vendorAddressCopy(locale);
  const id = useId();
  const sheet = useRef<HTMLDialogElement>(null);
  const [flow] = useState(() => createAddressFlow({ saver: createAddressSaver({ fetch: (input, init) => fetch(input, init), reload: () => window.location.reload() }),
    version, saved: address }));
  const [, rerender] = useState(0);
  const refresh = () => rerender(n => n + 1);
  const [touched, setTouched] = useState(false);
  const [state, setState] = useState<"idle" | "pending" | "failed">("idle");
  const parts = flow.parts;
  const errors = touched ? validateAddressParts(parts) : [];

  function confirm() {
    if (!flow.confirm()) return; // Unchanged: nothing to confirm or write.
    setTouched(false); setState("idle"); refresh();
    sheet.current?.showModal();
  }
  async function save() {
    setTouched(true);
    if (state === "pending") return;
    setState("pending");
    const outcome = await flow.save();
    setState(outcome === "saved" || outcome === "stale" || outcome === "invalid_parts" || outcome === "busy" ? "idle" : "failed");
  }
  const field = (key: keyof AddressParts, label: string, error?: string) => {
    const errorId = `${id}-${key}-error`;
    const common = { id: `${id}-${key}`, className: "v-addr-input", "aria-invalid": Boolean(error), "aria-describedby": error ? errorId : undefined };
    return <div className="v-addr-field">
      <label htmlFor={`${id}-${key}`}>{label}</label>
      {key === "city"
        ? <select {...common} value={parts.city} onChange={event => { flow.edit({ ...parts, city: event.target.value }); refresh(); }}>
          <option value="" />
          {TW_CITIES.map(city => <option key={city} value={city}>{city}</option>)}
        </select>
        : <input {...common} value={parts[key]} maxLength={200} onChange={event => { flow.edit({ ...parts, [key]: event.target.value }); refresh(); }} />}
      {error ? <p className="v-addr-error" id={errorId}>{error}</p> : null}
    </div>;
  };

  return <section className="v-addr-card" aria-labelledby={`${id}-card`}>
    {/* eslint-disable-next-line @next/next/no-css-tags -- workbench-only stylesheet */}
    <link rel="stylesheet" href="/brand/v3/vendor-address.css" />
    <h2 id={`${id}-card`}>{copy.card}</h2>
    <form className="v-addr-form" onSubmit={event => { event.preventDefault(); confirm(); }}>
      <label htmlFor={`${id}-line`}>{copy.field}</label>
      <input id={`${id}-line`} className="v-addr-input" value={flow.line} maxLength={500} aria-describedby={`${id}-help`}
        onChange={event => { flow.type(event.target.value); refresh(); }} />
      <p className="v-addr-help" id={`${id}-help`}>{copy.help}</p>
      <button type="submit" className="v-addr-primary">{copy.save}</button>
    </form>
    <dialog ref={sheet} className="v-addr-sheet" aria-labelledby={`${id}-title`}>
      <form onSubmit={event => { event.preventDefault(); void save(); }}>
        <h2 id={`${id}-title`}>{copy.title}</h2>
        <p>{flow.unreadable ? copy.unreadable : copy.lead}</p>
        {errors.length ? <p className="v-addr-error" role="alert">{copy.fix}</p> : null}
        {field("city", copy.city, errors.includes("city") ? copy.needCity : undefined)}
        {field("district", copy.district)}
        {field("street", copy.street, errors.includes("streetOrNumber") ? copy.needStreet : undefined)}
        {field("number", copy.number)}
        {state === "failed" ? <div className="v-addr-error" role="alert"><p>{copy.saveError}</p>
          <button type="submit" className="v-addr-secondary">{copy.retry}</button></div> : null}
        <button type="submit" className="v-addr-primary" disabled={state === "pending"} aria-busy={state === "pending"}>{copy.save}</button>
        <button type="button" className="v-addr-text" onClick={() => { flow.cancel(); sheet.current?.close(); refresh(); }}>{copy.cancel}</button>
      </form>
    </dialog>
    {/* B-065: the 開立類型 row and 管理印章 sit in the same 固定資料 card (ven-account). */}
    {children}
  </section>;
}
