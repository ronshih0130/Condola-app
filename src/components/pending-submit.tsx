"use client";

import type { CSSProperties } from "react";
import { useFormStatus } from "react-dom";

export function PendingSubmit({
  idle,
  pending,
  className,
  testId,
  disabled,
  style,
}: {
  idle: string;
  pending: string;
  className?: string;
  testId?: string;
  disabled?: boolean;
  style?: CSSProperties;
}) {
  const { pending: busy } = useFormStatus();
  return (
    <button className={className} type="submit" disabled={disabled || busy} data-testid={testId} aria-busy={busy ? true : undefined} style={style}>
      {busy ? pending : idle}
    </button>
  );
}
