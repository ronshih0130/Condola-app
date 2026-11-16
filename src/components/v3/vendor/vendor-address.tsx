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
export type SaveOutcome = "saved" | "conflict" | "invalid" | "failed" | "busy";

/** Request id fixed per confirm sheet, so a retry is a replay; reload on success or when the version moved. */
export function createAddressSaver(deps: { fetch: Fetch; reload: () => void; newId?: () => string }) {
  const newId = deps.newId ?? (() => globalThis.crypto.randomUUID());
  let requestId = newId(), busy = false;
  return {
    get busy() { return busy; },
    get requestId() { return requestId; },
    /** A new sheet (another typed line) is a new request. */
    reset() { requestId = newId(); },
    async save(expectedVersion: number, parts: AddressParts): Promise<SaveOutcome> {
      if (busy) return "busy";
      busy = true;
      try {
        const response = await deps.fetch("/api/vendor-account/address", {
          method: "POST", headers: { "content-type": "application/json" }, credentials: "same-origin",
          body: JSON.stringify({ requestId, expectedVersion, parts }),
        });
        const body = (await response.json().catch(() => null)) as { status?: string } | null;
        const outcome: SaveOutcome = response.ok && (body?.status === "recorded" || body?.status === "unchanged") ? "saved"
          : body?.status === "rejected_stale" || body?.status === "rejected_conflict" ? "conflict"
          : body?.status === "rejected_invalid" ? "invalid" : "failed";
        if (outcome === "saved" || outcome === "conflict") deps.reload();
        return outcome;
      } catch {
        return "failed";
      } finally {
        busy = false;
      }
    },
  };
}

export function VendorAddressCard({ locale, version, address }: { locale: Locale; version: number; address: string | null }) {
  const copy = vendorAddressCopy(locale);
  const id = useId();
  const sheet = useRef<HTMLDialogElement>(null);
  const [line, setLine] = useState(address ?? "");
  const [parts, setParts] = useState<AddressParts>({ city: "", district: "", street: "", number: "" });
  const [unreadable, setUnreadable] = useState(false);
  const [touched, setTouched] = useState(false);
  const [state, setState] = useState<"idle" | "pending" | "failed">("idle");
  const [saver] = useState(() => createAddressSaver({ fetch: (input, init) => fetch(input, init), reload: () => window.location.reload() }));
  const errors = touched ? validateAddressParts(parts) : [];

  function confirm() {
    if (line.trim() === (address ?? "").trim()) return; // Unchanged: nothing to confirm or write.
    const parsed = parseTwAddress(line);
    setParts(parsed.parts); setUnreadable(!parsed.ok); setTouched(false); setState("idle");
    saver.reset();
    sheet.current?.showModal();
  }
  async function save() {
    setTouched(true);
    if (validateAddressParts(parts).length || saver.busy) return;
    setState("pending");
    const outcome = await saver.save(version, parts);
    setState(outcome === "saved" || outcome === "conflict" || outcome === "busy" ? "idle" : "failed");
  }
  const field = (key: keyof AddressParts, label: string, error?: string) => <div className="v-addr-field">
    <label htmlFor={`${id}-${key}`}>{label}</label>
    {key === "city"
      ? <select id={`${id}-${key}`} className="v-addr-input" value={parts.city} aria-invalid={Boolean(error)}
        onChange={event => setParts({ ...parts, city: event.target.value })}>
        <option value="" />
        {TW_CITIES.map(city => <option key={city} value={city}>{city}</option>)}
      </select>
      : <input id={`${id}-${key}`} className="v-addr-input" value={parts[key]} maxLength={200} aria-invalid={Boolean(error)}
        onChange={event => setParts({ ...parts, [key]: event.target.value })} />}
    {error ? <p className="v-addr-error">{error}</p> : null}
  </div>;

  return <section className="v-addr-card" aria-labelledby={`${id}-card`}>
    {/* eslint-disable-next-line @next/next/no-css-tags -- workbench-only stylesheet */}
    <link rel="stylesheet" href="/brand/v3/vendor-address.css" />
    <h2 id={`${id}-card`}>{copy.card}</h2>
    <form className="v-addr-form" onSubmit={event => { event.preventDefault(); confirm(); }}>
      <label htmlFor={`${id}-line`}>{copy.field}</label>
      <input id={`${id}-line`} className="v-addr-input" value={line} maxLength={500} aria-describedby={`${id}-help`}
        onChange={event => setLine(event.target.value)} />
      <p className="v-addr-help" id={`${id}-help`}>{copy.help}</p>
      <button type="submit" className="v-addr-primary">{copy.save}</button>
    </form>
    <dialog ref={sheet} className="v-addr-sheet" aria-labelledby={`${id}-title`}>
      <form onSubmit={event => { event.preventDefault(); void save(); }}>
        <h2 id={`${id}-title`}>{copy.title}</h2>
        <p>{unreadable ? copy.unreadable : copy.lead}</p>
        {errors.length ? <p className="v-addr-error" role="alert">{copy.fix}</p> : null}
        {field("city", copy.city, errors.includes("city") ? copy.needCity : undefined)}
        {field("district", copy.district)}
        {field("street", copy.street, errors.includes("streetOrNumber") ? copy.needStreet : undefined)}
        {field("number", copy.number)}
        {state === "failed" ? <div className="v-addr-error" role="alert"><p>{copy.saveError}</p>
          <button type="submit" className="v-addr-secondary">{copy.retry}</button></div> : null}
        <button type="submit" className="v-addr-primary" disabled={state === "pending"} aria-busy={state === "pending"}>{copy.save}</button>
        <button type="button" className="v-addr-text" onClick={() => sheet.current?.close()}>{copy.cancel}</button>
      </form>
    </dialog>
  </section>;
}
