"use client";

import { useEffect } from "react";
import { actionClearResetFlash } from "@/server/auth-actions";

export function ClearResetFlash() {
  useEffect(() => {
    void actionClearResetFlash();
  }, []);
  return null;
}
