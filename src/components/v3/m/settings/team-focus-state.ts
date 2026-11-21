/**
 * R5-TEAM panel focus (MGT-133-AC5 / R5-FULL, and the invite panel). Pure: no React. When a panel is open it takes
 * focus (it is a tabIndex=-1 section); its 「關閉」/「取消」 return to /m/team#v3-team-add, where focus goes back to
 * 「新增同事」.
 */
export const TEAM_ADD_ID = "v3-team-add";
export const TEAM_PANEL_ID = "v3-team-panel";
export const TEAM_CLOSE_HREF = `/m/team#${TEAM_ADD_ID}`;
type Focusable = { focus: (options?: { preventScroll?: boolean }) => void };
export type FocusDocument = { getElementById: (id: string) => Focusable | null };

/** Returns the id that received focus, or null when nothing should move. */
export function focusTeamOnLoad(doc: FocusDocument, hash: string): string | null {
  const panel = doc.getElementById(TEAM_PANEL_ID);
  if (panel) { panel.focus(); return TEAM_PANEL_ID; }
  if (hash === `#${TEAM_ADD_ID}`) {
    const add = doc.getElementById(TEAM_ADD_ID);
    if (add) { add.focus(); return TEAM_ADD_ID; }
  }
  return null;
}
