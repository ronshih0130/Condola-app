"use client";

import { useState } from "react";
import { errorText } from "@/i18n/errors";
import { actionIssuePortalInvite } from "@/server/auth-actions";
import { useT } from "./locale";

export function PortalInviteButton({
  kind,
  contactId,
  leaseId,
  activated,
}: {
  kind: "owner" | "tenant";
  contactId: string;
  leaseId?: string;
  activated: boolean;
}) {
  const t = useT();
  const [phase, setPhase] = useState<"idle" | "copied" | "activated">(activated ? "activated" : "idle");
  const [url, setUrl] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const handoff = kind === "owner" ? t("i_portal_hand_owner") : t("i_portal_hand_tenant");

  async function issue(regenerate: boolean) {
    if (!regenerate && url) {
      try {
        await navigator.clipboard.writeText(url);
      } catch {
        // The link stays on this page so the manager can copy it again.
      }
      setPhase("copied");
      return;
    }
    setBusy(true);
    setError("");
    try {
      const result = await actionIssuePortalInvite({ kind, contactId, leaseId });
      if (!result.ok) {
        setError(errorText(t, result.error));
        return;
      }
      if (result.activated) {
        setPhase("activated");
        setUrl("");
        return;
      }
      try {
        await navigator.clipboard.writeText(result.url);
      } catch {
        // Shown only as a data attribute for a second copy attempt.
      }
      setUrl(result.url);
      setPhase("copied");
    } finally {
      setBusy(false);
    }
  }

  if (phase === "activated") {
    return (
      <p data-testid="portal-invite" style={{ marginTop: 12 }}>
        <span data-testid="portal-invite-activated">{t("i_portal_activated")}</span>
      </p>
    );
  }

  return (
    <div data-testid="portal-invite" style={{ marginTop: 12, display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
      <span className="small muted" data-testid="portal-invite-handoff">
        {handoff}
      </span>
      <button className="btn pri sm" type="button" data-testid="portal-invite-copy" disabled={busy} onClick={() => issue(false)}>
        {t("i_portal_copy")}
      </button>
      {phase === "copied" ? (
        <>
          <span className="small" data-testid="portal-invite-copied" data-url={url}>
            {t("i_portal_copied")}
          </span>
          <button className="btn sm" type="button" data-testid="portal-invite-regenerate" disabled={busy} onClick={() => issue(true)}>
            {t("i_portal_regenerate")}
          </button>
        </>
      ) : null}
      {error ? (
        <span className="small" data-testid="portal-invite-error">
          {error}
        </span>
      ) : null}
    </div>
  );
}
