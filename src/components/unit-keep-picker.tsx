"use client";

import { useState } from "react";
import { actionSaveKeptUnits } from "@/server/unit-limit-actions";

export type KeepSpace = { id: string; name: string; created: string };

export function UnitKeepPicker({
  spaces,
  keptIds,
  limit,
  openLabel,
  title,
  lead,
  createdLabel,
  note,
  saveLabel,
  cancelLabel,
}: {
  spaces: KeepSpace[];
  keptIds: string[];
  limit: number;
  openLabel: string;
  title: string;
  lead: string;
  createdLabel: string;
  note: string;
  saveLabel: string;
  cancelLabel: string;
}) {
  const [open, setOpen] = useState(false);
  const [selected, setSelected] = useState<string[]>(keptIds.slice(0, limit));
  const full = selected.length >= limit;

  function toggle(id: string) {
    setSelected((current) => {
      if (current.includes(id)) return current.filter((item) => item !== id);
      if (current.length >= limit) return current;
      return [...current, id];
    });
  }

  return (
    <>
      <button className="btn" type="button" data-testid="open-unit-keep" onClick={() => setOpen(true)}>
        {openLabel}
      </button>
      {open ? (
        <div className="modal-bg" role="dialog" aria-modal="true" aria-labelledby="unit-keep-title" data-testid="plan-s17">
          <form className="modal" action={actionSaveKeptUnits} style={{ width: "min(440px, 100%)" }}>
            <div className="hd">
              <h3 id="unit-keep-title">{title}</h3>
            </div>
            <div className="bd">
              <p className="small" data-testid="unit-keep-count">
                {lead.replaceAll("{n}", String(selected.length))}
              </p>
              <div className="keep-list">
                {spaces.map((space) => {
                  const on = selected.includes(space.id);
                  return (
                    <label key={space.id} data-testid={`keep-${space.id}`}>
                      <span>
                        <input
                          type="checkbox"
                          name="spaceId"
                          value={space.id}
                          checked={on}
                          disabled={!on && full}
                          onChange={() => toggle(space.id)}
                        />{" "}
                        {space.name}
                      </span>
                      <span className="small muted">{createdLabel.replaceAll("{d}", space.created)}</span>
                    </label>
                  );
                })}
              </div>
              <p className="small muted">{note}</p>
            </div>
            <div className="ft">
              <button className="btn" type="button" onClick={() => setOpen(false)}>
                {cancelLabel}
              </button>
              <button className="btn pri" type="submit" data-testid="save-kept" disabled={selected.length !== limit}>
                {saveLabel}
              </button>
            </div>
          </form>
        </div>
      ) : null}
    </>
  );
}
