"use client";

import { useEffect } from "react";

/** A server action would refresh /forgot and hide the confirmation immediately. */
export function ClearResetFlash() {
  useEffect(() => {
    void fetch("/api/reset-flash", { method: "POST" });
  }, []);
  return null;
}
