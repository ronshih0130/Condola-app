"use client";

import { useState } from "react";
import { actionMemberActive } from "@/server/auth-actions";

export function ConfirmDeactivate({
  memberId,
  email,
  label,
  confirmLabel,
  cancelLabel,
  note,
}: {
  memberId: string;
  email: string;
  label: string;
  confirmLabel: string;
  cancelLabel: string;
  note: string;
}) {
  const [open, setOpen] = useState(false);
  if (!open) {
    return (
      <button className="btn sm danger" type="button" data-testid={`deactivate-${email}`} onClick={() => setOpen(true)}>
        {label}
      </button>
    );
  }
  return (
    <form action={actionMemberActive}>
      <input type="hidden" name="memberId" value={memberId} />
      <input type="hidden" name="active" value="0" />
      <input type="hidden" name="confirm" value="yes" />
      <p className="tiny">{note}</p>
      <button className="btn sm danger" type="submit" data-testid={`deactivate-confirm-${email}`}>
        {confirmLabel}
      </button>
      <button className="btn sm" type="button" onClick={() => setOpen(false)}>
        {cancelLabel}
      </button>
    </form>
  );
}
