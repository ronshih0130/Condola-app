"use client";
import { useEffect } from "react";
import { focusTeamOnLoad } from "./team-focus-state";

/** Moves focus to an open panel, or back to 「新增同事」 after a panel was closed (see team-focus-state). */
export function TeamFocus({ panel }: { panel: string }) {
  useEffect(() => { focusTeamOnLoad(document, window.location.hash); }, [panel]);
  return null;
}
