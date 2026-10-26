"use client";

import { useEffect } from "react";
import { confirmHashTarget } from "@/server/signup-gotrue";

/** Supabase implicit links put access_token in the hash, which the server never sees. */
export function AuthHashForward() {
  useEffect(() => {
    const target = confirmHashTarget(window.location.pathname, window.location.hash);
    if (target) window.location.replace(target);
  }, []);
  return null;
}

/** Read the hash before leaving /. A server redirect would drop it in some mail clients. */
export function HashOrRedirect({ next }: { next: string }) {
  useEffect(() => {
    const target = confirmHashTarget(window.location.pathname, window.location.hash);
    window.location.replace(target ?? next);
  }, [next]);
  return null;
}
