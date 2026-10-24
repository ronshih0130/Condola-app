"use client";

import { useEffect, useState } from "react";
import { actionConfirmSupabase } from "@/server/signup-actions";

/** Hash fragments are not sent on GET, so a scanner cannot consume an access_token by prefetching. */
export function ConfirmHash() {
  const [started, setStarted] = useState(false);
  useEffect(() => {
    if (started) return;
    const hash = new URLSearchParams(window.location.hash.replace(/^#/, ""));
    const access = hash.get("access_token");
    if (!access) return;
    // Drop the JWT from the address bar before the server action is posted.
    window.history.replaceState(window.history.state, "", `${window.location.pathname}${window.location.search}`);
    setStarted(true);
    void actionConfirmSupabase(access);
  }, [started]);
  return null;
}
