"use client";

import { useEffect, useRef, useState } from "react";
import { usePathname } from "next/navigation";
import { errorText } from "@/i18n/errors";
import {
  PORTAL_COPY_HOLD_MS,
  portalFailureVisible,
  portalIssueFailureKey,
  portalSuccessVisible,
  startPortalCopy,
} from "@/lib/portal-copy";
import { portalPageTarget, sameId } from "@/lib/portal-page";
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
  const pathname = usePathname() || "";
  const page = portalPageTarget(pathname);
  const pageMatches =
    page?.kind === kind && (kind === "owner" ? sameId(page.pageId, contactId) : sameId(page.pageId, leaseId || ""));
  const [phase, setPhase] = useState<"idle" | "copied" | "failed" | "activated">(pageMatches && activated ? "activated" : "idle");
  const [url, setUrl] = useState("");
  const [copiedName, setCopiedName] = useState("");
  const [copiedEmail, setCopiedEmail] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [successAt, setSuccessAt] = useState<number | null>(null);
  const [failureAt, setFailureAt] = useState<number | null>(null);
  const [failureDismissed, setFailureDismissed] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const propsRef = useRef({ kind, contactId, leaseId });
  propsRef.current = { kind, contactId, leaseId };
  const urlRef = useRef("");
  urlRef.current = url;
  const handoff = kind === "owner" ? t("i_portal_hand_owner") : t("i_portal_hand_tenant");
  const successElapsed = successAt == null ? -1 : now - successAt;
  const failureElapsed = failureAt == null ? -1 : now - failureAt;
  const showSuccess = phase === "copied" && portalSuccessVisible(successElapsed, false);
  const showFailure = phase === "failed" && url !== "" && portalFailureVisible(failureElapsed, failureDismissed);

  useEffect(() => {
    setPhase(pageMatches && activated ? "activated" : "idle");
    setUrl("");
    setCopiedName("");
    setCopiedEmail("");
    setError("");
    setBusy(false);
    setSuccessAt(null);
    setFailureAt(null);
    setFailureDismissed(false);
  }, [pathname, pageMatches, kind, contactId, leaseId, activated]);

  useEffect(() => {
    if (!showSuccess || successAt == null) return;
    const wait = Math.max(0, PORTAL_COPY_HOLD_MS - (Date.now() - successAt));
    const timer = window.setTimeout(() => setNow(Date.now()), wait);
    return () => window.clearTimeout(timer);
  }, [showSuccess, successAt, url]);

  function markSuccess(nextUrl: string, name: string, email: string) {
    const stamped = Date.now();
    setCopiedName(name);
    setCopiedEmail(email);
    setUrl(nextUrl);
    setError("");
    setFailureDismissed(true);
    setSuccessAt(stamped);
    setNow(stamped);
    setPhase("copied");
  }

  function markClipboardFailure(nextUrl: string, name: string, email: string) {
    const stamped = Date.now();
    setCopiedName(name);
    setCopiedEmail(email);
    setUrl(nextUrl);
    setFailureAt(stamped);
    setNow(stamped);
    setFailureDismissed(false);
    setError(t("i_portal_copy_failed"));
    setPhase("failed");
  }

  async function issue(rotate: boolean) {
    const current = propsRef.current;
    const live = portalPageTarget(window.location.pathname);
    if (!live || live.kind !== current.kind) {
      setError(t(rotate ? "i_portal_link_mismatch" : "i_portal_copy_failed"));
      return;
    }
    const pageId = live.pageId;
    const contact = live.kind === "owner" ? live.pageId : current.contactId;
    const lease = live.kind === "tenant" ? live.pageId : undefined;
    if (live.kind === "owner" && !sameId(contact, pageId)) {
      setError(t(rotate ? "i_portal_link_mismatch" : "i_portal_copy_failed"));
      return;
    }
    if (rotate) {
      setError("");
      setFailureDismissed(true);
      setPhase("idle");
      setUrl("");
    }
    setBusy(true);
    let resolveLink: (value: string) => void = () => {};
    let rejectLink: (error: unknown) => void = () => {};
    const link = new Promise<string>((resolve, reject) => {
      resolveLink = resolve;
      rejectLink = reject;
    });
    const copyPromise = startPortalCopy(link, navigator.clipboard ?? {});
    try {
      const result = await actionIssuePortalInvite({
        kind: live.kind,
        contactId: contact,
        pageId,
        leaseId: lease,
        rotate,
      });
      if (!result.ok) {
        rejectLink(new Error("issue"));
        await copyPromise;
        setError(errorText(t, result.error));
        return;
      }
      if (!sameId(result.contactId, contact)) {
        rejectLink(new Error("mismatch"));
        await copyPromise;
        setError(t("i_portal_link_mismatch"));
        return;
      }
      if (result.activated) {
        rejectLink(new Error("activated"));
        await copyPromise;
        setPhase("activated");
        setUrl("");
        setCopiedName("");
        setCopiedEmail("");
        setError("");
        return;
      }
      resolveLink(result.url);
      const copied = await copyPromise;
      if (!copied.ok) {
        markClipboardFailure(result.url, result.name, result.email);
        return;
      }
      markSuccess(result.url, result.name, result.email);
    } catch (error) {
      rejectLink(error);
      await copyPromise.catch(() => undefined);
      setPhase("idle");
      setUrl("");
      setCopiedName("");
      setCopiedEmail("");
      setError(t(portalIssueFailureKey(error, typeof navigator === "undefined" ? true : navigator.onLine)));
    } finally {
      setBusy(false);
    }
  }

  function regenerate() {
    if (!window.confirm(t("i_portal_regenerate_confirm"))) return;
    void issue(true);
  }

  function dismissFailure() {
    setFailureDismissed(true);
    setError("");
    setPhase("idle");
    setUrl("");
  }

  function copyVisibleLink() {
    const text = urlRef.current;
    if (!text) return;
    const clipboard = navigator.clipboard as
      | { write?: (items: ClipboardItem[]) => Promise<void>; writeText?: (value: string) => Promise<void> }
      | undefined;
    const Item = typeof ClipboardItem === "function" ? ClipboardItem : undefined;
    const attempt =
      clipboard?.write && Item
        ? clipboard.write([new Item({ "text/plain": new Blob([text], { type: "text/plain" }) })])
        : clipboard?.writeText?.(text) ?? Promise.reject(new Error("clipboard"));
    void attempt.then(
      () => markSuccess(text, copiedName, copiedEmail),
      () => markClipboardFailure(text, copiedName, copiedEmail),
    );
  }

  if (phase === "activated") {
    return (
      <div data-testid="portal-invite" style={{ marginTop: 12, display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
        <span data-testid="portal-invite-activated">{t("i_portal_activated")}</span>
        <button className="btn sm" type="button" data-testid="portal-invite-regenerate" disabled={busy} onClick={regenerate}>
          {t("i_portal_regenerate")}
        </button>
      </div>
    );
  }

  return (
    <div data-testid="portal-invite" style={{ marginTop: 12, display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
      <span className="small muted" data-testid="portal-invite-handoff">
        {handoff}
      </span>
      <button
        className="btn pri sm"
        type="button"
        data-testid="portal-invite-copy"
        data-page-id={page?.pageId || ""}
        disabled={busy}
        aria-busy={busy || undefined}
        onClick={() => void issue(false)}
      >
        {busy ? t("i_portal_issuing") : t("i_portal_copy")}
      </button>
      <button className="btn sm" type="button" data-testid="portal-invite-regenerate" disabled={busy} onClick={regenerate}>
        {t("i_portal_regenerate")}
      </button>
      {showSuccess ? (
        <>
          <span
            className="small"
            data-testid="portal-invite-copied"
            data-url={url}
            data-email={copiedEmail}
            data-name={copiedName}
            data-min-ms={PORTAL_COPY_HOLD_MS}
          >
            {t("i_portal_copied_for", { name: copiedName, email: copiedEmail })}
          </span>
          <span className="small" data-testid="portal-invite-url">
            {url}
          </span>
        </>
      ) : null}
      {showFailure ? (
        <div data-testid="portal-invite-failure" style={{ flexBasis: "100%" }}>
          <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
            <span className="small" data-testid="portal-invite-error">
              {t("i_portal_copy_failed")}
            </span>
            <button className="btn ghost sm" type="button" data-testid="portal-invite-error-dismiss" aria-label={t("i_close")} onClick={dismissFailure}>
              ✕
            </button>
          </div>
          <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap", marginTop: 8 }}>
            <input className="inp" readOnly value={url} data-testid="portal-invite-link" style={{ minWidth: 240, flex: "1 1 240px" }} />
            <button className="btn sm" type="button" data-testid="portal-invite-manual-copy" onClick={copyVisibleLink}>
              {t("i_portal_copy_manual")}
            </button>
          </div>
        </div>
      ) : null}
      {error && !showFailure ? (
        <span className="small" data-testid="portal-invite-error">
          {error}
        </span>
      ) : null}
    </div>
  );
}
