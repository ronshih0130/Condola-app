"use client";

import React, { useState, useSyncExternalStore } from "react";
import { useRouter } from "next/navigation";
import type { Locale } from "../../../../i18n";
import { brandV3AssignCopy, fillAssign } from "../../../../i18n/lanes/brand-v3-assign";
import { createAssignFormController, toggleUnitId, type AssignSubmitInput } from "../../../../lib/assign-form";

export type AssignFormUnit = { id: string; label: string };
export type AssignSubmit = (input: AssignSubmitInput) => Promise<boolean>;
type Props = { locale: Locale; target: string; name: string; units: AssignFormUnit[]; checked: string[]; doneHref: string; submit?: AssignSubmit };

/** POST /api/maint-unit-assign; true only on a 2xx answer. */
export const postAssign: AssignSubmit = async input => {
  const response = await fetch("/api/maint-unit-assign", {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(input), credentials: "same-origin",
  });
  return response.ok;
};

/** Kept for callers and tests: the checks in unit order. */
export function toggleUnit(units: readonly AssignFormUnit[], checked: readonly string[], id: string): string[] {
  return toggleUnitId(units.map(u => u.id), checked, id);
}

/**
 * 負責的單位・{名字} (MGT-118-AC1, AC8). The save lifecycle is `createAssignFormController` (src/lib/assign-form.ts):
 * the checks are frozen while a save is in flight (the fieldset is disabled), a failed save keeps every check and
 * stays on the page with the GS-02 sentence (「儲存」 is then the retry, reusing the same request id), any change gets a
 * new id, and a save returns to 設定 › 單位分派 only when nothing changed after it was sent.
 */
export function AssignForm({ submit = postAssign, ...props }: Props) {
  const router = useRouter();
  const [controller] = useState(() => createAssignFormController({
    unitIds: props.units.map(u => u.id), checked: props.checked, target: props.target, submit,
    done: () => { router.push(props.doneHref); router.refresh(); },
  }));
  const state = useSyncExternalStore(controller.subscribe, controller.state, controller.state);
  return <AssignFormView {...props} checked={[...state.checked]} saving={state.saving} failed={state.failed}
    onToggle={id => { controller.toggle(id); }}
    onSubmit={event => { event.preventDefault(); void controller.save(); }} />;
}

type ViewProps = Omit<Props, "submit" | "target" | "doneHref"> & {
  saving: boolean; failed: boolean; onToggle?: (id: string) => void; onSubmit?: (event: React.FormEvent<HTMLFormElement>) => void;
};
export function AssignFormView(props: ViewProps) {
  const c = brandV3AssignCopy(props.locale);
  return <form className="v3-assign-form" onSubmit={props.onSubmit} noValidate aria-busy={props.saving || undefined} data-testid="assign-form">
    <fieldset className="v3-assign-units" disabled={props.saving} aria-disabled={props.saving || undefined}>
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
