"use client";

import { useEffect, useRef } from "react";
import { useRouter } from "next/navigation";

/**
 * Keeps B-026 V-13 behaviour once /vendor-account shows the workbench: the account page used to POST
 * {action:"sync"} on every visit, linking this account's still-open jobs. Same API, same call; silent on
 * failure (the workbench read stays the source of what is shown). Refreshes only when a job was linked.
 */
export function VendorAccountSync() {
  const router = useRouter();
  const started = useRef(false);
  useEffect(() => {
    if (started.current) return;
    started.current = true;
    void fetch("/api/vendor-account", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "sync" }) })
      .then(response => response.ok ? response.json() : null)
      .then((result: { linked?: unknown } | null) => { if (typeof result?.linked === "number" && result.linked > 0) router.refresh(); })
      .catch(() => {});
  }, [router]);
  return null;
}
