"use client";

import { actionConfirmUtility } from "@/server/actions";

/** Client form so confirm navigates and the posted state replaces the draft. */
export function UtilityConfirmForm({
  runId,
  month,
  unitId,
  label,
}: {
  runId: string;
  month: string;
  unitId: string;
  label: string;
}) {
  return (
    <form action={actionConfirmUtility}>
      <input type="hidden" name="runId" value={runId} />
      <input type="hidden" name="month" value={month} />
      <input type="hidden" name="unitId" value={unitId} />
      <button className="btn pri" type="submit" data-testid="utility-confirm" formAction={actionConfirmUtility}>
        {label}
      </button>
    </form>
  );
}
