/**
 * R5-TEAM 「要求全體成員啟用兩步驟驗證」 switch state (MGT-133-AC7). Pure: no server or React imports. `saved` is what
 * the server stored; `shown` is what the switch draws. One save at a time.
 */
export type TeamSecurityState = { saved: boolean; shown: boolean; saving: boolean; error: boolean };
export type TeamSecurityOutcome = { ok: true; required: boolean } | { ok: false; status: number } | "threw";
export const TEAM_SECURITY_API = "/api/team-security";

/** POST the new value. Any non-2xx (403 included) or malformed answer is a failure; a network error is "threw". */
export async function postTeamSecurity(required: boolean, fetcher: typeof fetch = fetch): Promise<TeamSecurityOutcome> {
  let response: Response;
  try {
    response = await fetcher(TEAM_SECURITY_API, { method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ required }) });
  } catch { return "threw"; }
  if (!response.ok) return { ok: false, status: response.status };
  try {
    const body = await response.json() as { required?: unknown };
    if (typeof body?.required === "boolean") return { ok: true, required: body.required };
  } catch { /* malformed */ }
  return { ok: false, status: response.status };
}
export function initialTeamSecurity(required: boolean): TeamSecurityState {
  return { saved: required, shown: required, saving: false, error: false };
}
/** A tap flips the switch at once and starts its save; while a save runs, a tap does nothing (null). */
export function startSecurityToggle(state: TeamSecurityState): TeamSecurityState | null {
  if (state.saving) return null;
  return { saved: state.saved, shown: !state.saved, saving: true, error: false };
}
/** Success stores what the server answered; any failure returns the switch to its saved value, with the error line. */
export function afterSecuritySave(state: TeamSecurityState, outcome: TeamSecurityOutcome): TeamSecurityState {
  if (outcome !== "threw" && outcome.ok) return initialTeamSecurity(outcome.required);
  return { saved: state.saved, shown: state.saved, saving: false, error: true };
}
/** Newer server props replace the local value only while nothing is saving. */
export function syncTeamSecurity(state: TeamSecurityState, required: boolean): TeamSecurityState {
  if (state.saving || state.saved === required) return state;
  return initialTeamSecurity(required);
}
