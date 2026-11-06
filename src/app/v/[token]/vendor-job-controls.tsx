"use client";

import { useRef, useState, type FormEvent, type ReactNode } from "react";
import { useRouter } from "next/navigation";

type Copy = {
  reported: string;
  unavailable: string;
};

export function VendorJobControls({
  hasAfterPhoto, copy, children,
}: {
  hasAfterPhoto: boolean;
  copy: Copy;
  children: ReactNode;
}) {
  const router = useRouter();
  const inFlight = useRef(false);
  const [busy, setBusy] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const [message, setMessage] = useState("");
  async function submit(event: FormEvent<HTMLDivElement>) {
    const form = event.target;
    if (!(form instanceof HTMLFormElement)) return;
    event.preventDefault();
    if (inFlight.current || submitted) return;
    const data = new FormData(form);
    const requestId = data.get("requestId");
    const token = data.get("token");
    const action = data.get("action");
    const note = data.get("reason");
    const reason = typeof note === "string" ? note.trim() || null : null;
    inFlight.current = true;
    setBusy(true);
    setMessage("");
    try {
      const instant = (name: string) => {
        const value = data.get(name);
        if (typeof value !== "string" || !value) throw new Error("Missing time");
        const date = new Date(value);
        if (!Number.isFinite(date.getTime())) throw new Error("Invalid time");
        return date.toISOString();
      };
      const payload = action === "complete"
        ? { requestId, token, hasAfterPhoto, reason }
        : { requestId, token, action, reason,
          ...(action === "propose" ? {
            times: { proposedStart: instant("proposedStart"), proposedEnd: instant("proposedEnd") },
          } : {}) };
      const response = await fetch(action === "complete"
        ? "/api/vendor-job-completion" : "/api/vendor-job-response", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const result: { status?: string } = await response.json();
      const recorded = response.ok && result.status === "recorded";
      setMessage(recorded ? copy.reported : copy.unavailable);
      if (recorded || ["rejected_conflict", "rejected_locked", "rejected_disabled"].includes(result.status ?? "")) {
        setSubmitted(true);
        router.refresh();
      }
    } catch {
      setMessage(copy.unavailable);
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  }
  return (
    <div onSubmit={submit}>
      <fieldset disabled={busy || submitted} style={{ border: 0, margin: 0, padding: 0 }} aria-busy={busy}>
        {children}
      </fieldset>
      <p role="status">{message}</p>
    </div>
  );
}
