import React from "react";

/** Decorative clock for a step handed to someone else (Brand 3.0 tick rule, PLT-51-AC2).
 * The paths are the package mockup's `i-wait` symbol. Render it only beside the status text. */
export function WaitMark() {
  return <span className="v3-wait" aria-hidden="true">
    <svg viewBox="0 0 16 16" fill="none" focusable="false" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="8" cy="8" r="6.2" />
      <path d="M8 4.7V8l2.3 1.5" />
    </svg>
  </span>;
}
