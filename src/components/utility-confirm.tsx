"use client";

import { useFormStatus } from "react-dom";
import { actionConfirmUtility } from "@/server/actions";

export function PendingSubmit({
  label,
  pendingLabel,
  testId,
  className,
}: {
  label: string;
  pendingLabel: string;
  testId: string;
  className?: string;
}) {
  const { pending } = useFormStatus();
  return (
    <button className={className ?? "btn"} type="submit" data-testid={testId} disabled={pending}>
      {pending ? pendingLabel : label}
    </button>
  );
}

/** Client form so confirm navigates and the posted state replaces the draft. */
export function UtilityConfirmForm({
  runId,
  month,
  unitId,
  label,
  pendingLabel,
}: {
  runId: string;
  month: string;
  unitId: string;
  label: string;
  pendingLabel: string;
}) {
  return (
    <form action={actionConfirmUtility}>
      <input type="hidden" name="runId" value={runId} />
      <input type="hidden" name="month" value={month} />
      <input type="hidden" name="unitId" value={unitId} />
      <PendingSubmit label={label} pendingLabel={pendingLabel} testId="utility-confirm" className="btn pri" />
    </form>
  );
}
