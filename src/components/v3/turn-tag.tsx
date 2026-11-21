import React from "react";

export function TurnTag({ children }: { children: React.ReactNode }) {
  return <span className="turn-tag" aria-current="step">{children}</span>;
}
