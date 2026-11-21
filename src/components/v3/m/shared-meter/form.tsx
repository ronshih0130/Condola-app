"use client";

import React, { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import type { Locale } from "../../../../i18n";
import { noteMonth, sharedMeterCopy } from "../../../../i18n/lanes/brand-v3-shared-meter";
import { saveSharedMeterAction } from "../../../../server/b109-shared-meter-actions";
import type { SharedMeterInput, SharedMeterResult } from "../../../../server/b109-shared-meter";
import { initialMeterForm, meterFormErrors, normalizeReading, SPLIT_METHODS, toggleSpace, type FormSpace, type MeterFormErrors,
  type MeterFormState, type SplitMethod } from "../../../../lib/shared-meter";

type Props = {
  locale: Locale; propertyId: string; backHref: string; spaces: FormSpace[];
  config: { spaceIds: string[]; method: SplitMethod; startReading: string } | null; nextEffectiveFrom: string;
  submit?: (input: SharedMeterInput) => Promise<SharedMeterResult>;
};

/**
 * ADV-METER form (MGT-90-AC4…AC6). One request key per unsent change: a retry of the same values reuses it;
 * any edit gets a new one. A failed save keeps every input (GS-02). Saved: the toast 「公用電表已儲存」 and the
 * page data refreshes (進階設定 itself is not built yet, so the page stays).
 */
export function SharedMeterForm({ submit = saveSharedMeterAction, ...props }: Props) {
  const router = useRouter();
  const [state, setState] = useState<MeterFormState>(() => initialMeterForm(props.spaces, props.config));
  const [shown, setShown] = useState<MeterFormErrors>({ rooms: false, start: false });
  const [saving, setSaving] = useState(false);
  const [failed, setFailed] = useState(false);
  const [saved, setSaved] = useState(false);
  const key = useRef<string>("");
  const change = (next: MeterFormState) => { key.current = ""; setSaved(false); setState(next); };
  const toggle = (id: string) => change({ ...state, spaces: toggleSpace(props.spaces, state.spaces, id) });
  async function save(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (saving) return;
    const errors = meterFormErrors(state);
    setShown(errors);
    if (errors.rooms || errors.start) return;
    if (!key.current) key.current = globalThis.crypto.randomUUID();
    setSaving(true); setFailed(false);
    let result: SharedMeterResult;
    try {
      result = await submit({ propertyId: props.propertyId, requestId: key.current, spaceIds: state.spaces, method: state.method,
        startReading: normalizeReading(state.start) });
    } catch {
      result = { ok: false, reason: "failed" };
    }
    setSaving(false);
    if (!result.ok) { setFailed(true); return; }
    key.current = "";
    setSaved(true);
    router.refresh();
  }
  return <MeterFormView {...props} state={state} errors={shown} saving={saving} failed={failed} saved={saved}
    onToggle={toggle} onMethod={method => change({ ...state, method })} onStart={start => change({ ...state, start })} onSubmit={save} />;
}

type ViewProps = Omit<Props, "submit" | "propertyId" | "config"> & {
  state: MeterFormState; errors: MeterFormErrors; saving: boolean; failed: boolean; saved: boolean;
  onToggle?: (id: string) => void; onMethod?: (method: SplitMethod) => void; onStart?: (value: string) => void;
  onSubmit?: (event: React.FormEvent<HTMLFormElement>) => void;
};
/** The frame: rooms (≥44px, all ticked by default) + 「分給 {n} 間」, method cards, 起始度數 + help, 每度電價 row, note. */
export function MeterFormView(props: ViewProps) {
  const c = sharedMeterCopy(props.locale);
  return <form className="v3-meter-form v3-meter-card" onSubmit={props.onSubmit} noValidate>
    <fieldset className="v3-meter-field">
      <legend>{c.rooms}</legend>
      <div className="v3-meter-rooms">{props.spaces.map(space => <label key={space.id} className="v3-meter-room">
        <input type="checkbox" checked={props.state.spaces.includes(space.id)} onChange={() => props.onToggle?.(space.id)}
          aria-invalid={props.errors.rooms} data-testid="meter-space" />
        <span>{space.label}</span></label>)}</div>
      <small aria-live="polite" data-testid="meter-count">{c.count.replace("{n}", String(props.state.spaces.length))}</small>
      {props.errors.rooms ? <p className="v3-meter-error" role="alert" data-testid="meter-err-rooms">{c.errRooms}</p> : null}
    </fieldset>
    <fieldset className="v3-meter-field">
      <legend>{c.method}</legend>
      <div className="v3-meter-methods">{SPLIT_METHODS.map(method => <label key={method}
        className={`v3-meter-method${props.state.method === method ? " on" : ""}`}>
        <input type="radio" name="method" value={method} checked={props.state.method === method}
          onChange={() => props.onMethod?.(method)} data-testid="meter-method" />
        <b>{c.methods[method]}</b></label>)}</div>
    </fieldset>
    <label className="v3-meter-field v3-meter-start">
      <span className="v3-meter-label">{c.start}</span>
      <input name="start" inputMode="decimal" value={props.state.start} onChange={event => props.onStart?.(event.target.value)}
        aria-invalid={props.errors.start} aria-describedby="meter-start-help" data-testid="meter-start" />
      <small id="meter-start-help">{c.startHelp}</small>
      {props.errors.start ? <p className="v3-meter-error" role="alert" data-testid="meter-err-start">{c.errStart}</p> : null}
    </label>
    {/* The price lives only in the money-flow 電費規則 (MGT-90-AC5). Its 「設定」 link is hidden until that page exists. */}
    <div className="v3-meter-price"><b>{c.price}</b><span>{c.priceWhere}</span></div>
    <p className="v3-meter-note" data-testid="meter-note">{c.note.replace("{m}", noteMonth(props.nextEffectiveFrom, props.locale))}</p>
    <p className="v3-meter-fail" role="alert" data-testid="meter-failed">{props.failed ? c.saveFailed : null}</p>
    <div className="v3-meter-actions">
      <button type="submit" className="btn pri" disabled={props.saving} aria-busy={props.saving} data-testid="meter-save">
        {props.failed ? c.retry : c.save}</button>
      <a className="btn txt" href={props.backHref}>{c.cancel}</a>
    </div>
    <div className="toast v3-meter-toast" role="status" data-testid="meter-saved">{props.saved ? c.saved : null}</div>
  </form>;
}
