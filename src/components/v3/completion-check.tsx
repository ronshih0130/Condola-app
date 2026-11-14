import React from "react";

/** Decorative: render only beside an explicit confirmed-payment label. */
export function CompletionCheck() {
  return <span className="v3-check" aria-hidden="true">
    <svg viewBox="0 0 100 100" fill="none" focusable="false" strokeLinecap="round" strokeLinejoin="round">
      <path d="M78 40 L50 14 L22 40 C11 50 16 71 29 81 C43 91 64 90 78 80" stroke="var(--c-primary)" strokeWidth="15" />
      <path className="v3-check-tick" pathLength="1" d="M45 56 L53 64 L67 50" stroke="var(--c-brand)" strokeWidth="9" />
    </svg>
  </span>;
}
