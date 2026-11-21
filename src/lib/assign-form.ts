/**
 * B-059 負責的單位・{名字} save lifecycle (MGT-118-AC1, AC8; Codex r1 Part 3). Pure, framework-free: the client form
 * subscribes to it. Rules:
 * - While a save is in flight the checks are frozen (toggle is refused and the form disables its fieldset), so no
 *   edit can be made that the request does not carry.
 * - A failed save keeps every check and the request id: an unchanged retry reuses the id (the gateway replays it).
 * - Any change after a failure (or before the first save) drops the id, so the next save gets a new one.
 * - Success leaves the editor only when the checks still equal what was sent; otherwise it stays (defensive).
 */
export type AssignFormState = { readonly checked: readonly string[]; readonly saving: boolean; readonly failed: boolean };
export type AssignSubmitInput = { requestId: string; target: string; units: string[] };
export type AssignSaveOutcome = "saved" | "failed" | "busy" | "stayed";
type Options = {
  unitIds: readonly string[]; checked: readonly string[]; target: string;
  submit: (input: AssignSubmitInput) => Promise<boolean>; done: () => void; newId?: () => string;
};

/** The checks in unit order; toggling one never reorders or drops the others. */
export function toggleUnitId(unitIds: readonly string[], checked: readonly string[], id: string): string[] {
  const next = new Set(checked);
  if (next.has(id)) next.delete(id); else next.add(id);
  return unitIds.filter(u => next.has(u));
}

export function createAssignFormController(options: Options) {
  let state: AssignFormState = { checked: options.unitIds.filter(id => options.checked.includes(id)), saving: false, failed: false };
  let key = "";
  const listeners = new Set<() => void>();
  const set = (next: Partial<AssignFormState>) => { state = { ...state, ...next }; for (const listener of listeners) listener(); };
  const newId = options.newId ?? (() => globalThis.crypto.randomUUID());
  return {
    state: () => state,
    requestId: () => key,
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    /** Refused (false) while a save is in flight. */
    toggle(id: string): boolean {
      if (state.saving || !options.unitIds.includes(id)) return false;
      key = "";
      set({ checked: toggleUnitId(options.unitIds, state.checked, id) });
      return true;
    },
    async save(): Promise<AssignSaveOutcome> {
      if (state.saving) return "busy";
      if (!key) key = newId();
      const sent = [...state.checked];
      set({ saving: true, failed: false });
      let ok = false;
      try { ok = await options.submit({ requestId: key, target: options.target, units: sent }); } catch { ok = false; }
      if (!ok) { set({ saving: false, failed: true }); return "failed"; }
      const unchanged = sent.length === state.checked.length && sent.every((id, i) => id === state.checked[i]);
      key = "";
      set({ saving: false });
      if (!unchanged) return "stayed";
      options.done();
      return "saved";
    },
  };
}
export type AssignFormController = ReturnType<typeof createAssignFormController>;
