"use client";

import React, { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import type { Locale } from "../../../../i18n";
import { brandV3AssignCopy, fillAssign } from "../../../../i18n/lanes/brand-v3-assign";

export type AssignFormUnit = { id: string; label: string };
export type AssignSubmit = (input: { requestId: string; target: string; units: string[] }) => Promise<boolean>;
type Props = { locale: Locale; target: string; name: string; units: AssignFormUnit[]; checked: string[]; doneHref: string; submit?: AssignSubmit };

/** POST /api/maint-unit-assign; true only on a 2xx answer. */
export const postAssign: AssignSubmit = async input => {
  const response = await fetch("/api/maint-unit-assign", {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(input), credentials: "same-origin",
  });
  return response.ok;
};

/** The checks in unit order; toggling one never reorders or drops the others. */
export function toggleUnit(units: readonly AssignFormUnit[], checked: readonly string[], id: string): string[] {
  const next = new Set(checked);
  if (next.has(id)) next.delete(id); else next.add(id);
  return units.map(u => u.id).filter(u => next.has(u));
}

/**
 * 負責的單位・{名字} (MGT-118-AC1, AC8). One request id per unsent change: a retry of the same checks reuses it, any
 * change gets a new one (the gateway replays a reused id). A failed save keeps every check, stays on the page and
 * shows the GS-02 sentence; 「儲存」 is then the retry. Saved: back to 設定 › 單位分派.
 */
export function AssignForm({ submit = postAssign, ...props }: Props) {
  const router = useRouter();
  const [checked, setChecked] = useState<string[]>(() => props.units.map(u => u.id).filter(id => props.checked.includes(id)));
  const [saving, setSaving] = useState(false);
  const [failed, setFailed] = useState(false);
  const key = useRef("");
  const toggle = (id: string) => { key.current = ""; setChecked(current => toggleUnit(props.units, current, id)); };
  async function save(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (saving) return;
    if (!key.current) key.current = globalThis.crypto.randomUUID();
    setSaving(true); setFailed(false);
    let ok = false;
    try { ok = await submit({ requestId: key.current, target: props.target, units: checked }); } catch { ok = false; }
    setSaving(false);
    if (!ok) { setFailed(true); return; }
    key.current = "";
    router.push(props.doneHref);
    router.refresh();
  }
  return <AssignFormView {...props} checked={checked} saving={saving} failed={failed} onToggle={toggle} onSubmit={save} />;
}

type ViewProps = Omit<Props, "submit" | "target" | "doneHref"> & {
  saving: boolean; failed: boolean; onToggle?: (id: string) => void; onSubmit?: (event: React.FormEvent<HTMLFormElement>) => void;
};
export function AssignFormView(props: ViewProps) {
  const c = brandV3AssignCopy(props.locale);
  return <form className="v3-assign-form" onSubmit={props.onSubmit} noValidate data-testid="assign-form">
    <fieldset className="v3-assign-units">
      <legend>{fillAssign(c.editHelp, { name: props.name })}</legend>
      {props.units.map(unit => <label key={unit.id} className="v3-assign-check">
        <input type="checkbox" checked={props.checked.includes(unit.id)} onChange={() => props.onToggle?.(unit.id)} data-testid="assign-unit" value={unit.id} />
        <span>{unit.label}</span>
      </label>)}
    </fieldset>
    <p className="v3-assign-fail" role="alert" data-testid="assign-fail">{props.failed ? c.saveFailed : ""}</p>
    <div className="v3-assign-actions">
      <button className="btn pri" type="submit" aria-disabled={props.saving || undefined} data-testid="assign-save">{c.save}</button>
    </div>
  </form>;
}
