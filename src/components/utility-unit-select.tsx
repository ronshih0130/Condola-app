"use client";

import { useEffect, useState } from "react";

/** Uncontrolled selects keep the first choice across a client navigation. This one follows the URL. */
export function UtilityUnitSelect({
  units,
  selectedId,
}: {
  units: { id: string; label: string }[];
  selectedId: string;
}) {
  const [value, setValue] = useState(selectedId);
  useEffect(() => {
    setValue(selectedId);
  }, [selectedId]);
  return (
    <select
      id="utility-unit"
      className="inp"
      name="unit"
      data-testid="utility-unit"
      value={value}
      onChange={(event) => setValue(event.target.value)}
    >
      {units.map((unit) => (
        <option key={unit.id} value={unit.id}>
          {unit.label}
        </option>
      ))}
    </select>
  );
}
