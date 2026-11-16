/** B-109 ADV-METER pure helpers, shared by the server reader/writer and the client form. */
export const SPLIT_METHODS = ["even", "days_occupied", "sub_meter"] as const;
export type SplitMethod = (typeof SPLIT_METHODS)[number];
/** 起始度數: a non-negative reading below 10^11 with at most 3 decimals (the column is numeric(14,3)). */
export const READING = /^(?:0|[1-9][0-9]{0,10})(?:\.[0-9]{1,3})?$/;
export const normalizeReading = (value: string) => value.trim().replace(/[,，]/g, "");
/** A stored numeric(14,3) reading for the form: 「1284.000」 → 「1284」, 「10.500」 → 「10.5」. */
export const displayReading = (value: string) => value.includes(".") ? value.replace(/\.?0+$/, "") : value;

export type FormSpace = { id: string; label: string };
export type MeterFormState = { spaces: string[]; method: SplitMethod; start: string };
export type MeterFormErrors = { rooms: boolean; start: boolean };

/** The form's starting values: the latest saved revision, else every space ticked, 平均分 and an empty reading. */
export function initialMeterForm(spaces: FormSpace[], config: { spaceIds: string[]; method: SplitMethod; startReading: string } | null): MeterFormState {
  if (!config) return { spaces: spaces.map(s => s.id), method: "even", start: "" };
  const present = new Set(spaces.map(s => s.id));
  return { spaces: config.spaceIds.filter(id => present.has(id)), method: config.method, start: displayReading(config.startReading) };
}
/** MGT-90-AC6: no space ticked, or an empty or malformed reading, shows the field's error and nothing is sent. */
export function meterFormErrors(state: MeterFormState): MeterFormErrors {
  return { rooms: state.spaces.length === 0, start: !READING.test(normalizeReading(state.start)) };
}
/** Toggling keeps the selection in display order. */
export function toggleSpace(spaces: FormSpace[], selected: string[], id: string): string[] {
  return selected.includes(id) ? selected.filter(x => x !== id) : spaces.map(s => s.id).filter(x => x === id || selected.includes(x));
}
