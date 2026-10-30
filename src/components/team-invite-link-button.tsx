"use client";

import { useEffect, useRef, useState } from "react";
import { usePathname } from "next/navigation";
import { errorText } from "@/i18n/errors";
import { startPortalCopy } from "@/lib/portal-copy";
import { actionIssueTeamInviteLink } from "@/server/auth-actions";
import { useT } from "./locale";

export type TeamInviteLink = { url: string; expiresAt: string; email: string };

export function TeamInviteLinkDisplay({ link, initiallyCopied = false }: {
  link: TeamInviteLink;
  initiallyCopied?: boolean;
}) {
  const t = useT();
  const [revealed, setRevealed] = useState(false);
  const [copied, setCopied] = useState(initiallyCopied);
  const [failed, setFailed] = useState(false);
  const active = useRef(false);
  useEffect(() => {
    active.current = true;
    setRevealed(false);
    setCopied(initiallyCopied);
    setFailed(false);
    return () => { active.current = false; };
  }, [link, initiallyCopied]);

  async function copy() {
    const result = await startPortalCopy(Promise.resolve(link.url), navigator.clipboard ?? {});
    if (!active.current) return;
    setCopied(result.ok);
    setFailed(!result.ok);
  }

  return (
    <div className="col">
      <span className="small">{link.email}</span>
      <input
        className="inp"
        readOnly
        aria-label={t("i_team_invite_copy")}
        value={revealed ? link.url : "…/join#••••"}
        autoComplete="off"
        spellCheck={false}
      />
      <div>
        <button className="btn sm" type="button" onClick={() => void copy()}>{t("i_team_invite_copy")}</button>
        <button className="btn sm" type="button" onClick={() => setRevealed(true)}>{t("i_team_invite_reveal")}</button>
      </div>
      {copied ? <p className="small" role="status">{t("i_team_invite_copied", {
        d: new Date(link.expiresAt).toLocaleDateString(undefined, { timeZone: "Asia/Taipei" }),
      })}</p> : null}
      {failed ? <p className="small" role="alert">{t("i_team_invite_copy_failed")}</p> : null}
    </div>
  );
}

export function TeamInviteLinkButton({ invitationId }: { invitationId: string }) {
  const t = useT();
  const pathname = usePathname();
  const [link, setLink] = useState<TeamInviteLink | null>(null);
  const [copied, setCopied] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const generation = useRef(0);

  useEffect(() => {
    generation.current += 1;
    setLink(null);
    setCopied(false);
    setBusy(false);
    setError("");
    function clear() {
      generation.current += 1;
      setLink(null);
    }
    window.addEventListener("pagehide", clear);
    return () => {
      generation.current += 1;
      window.removeEventListener("pagehide", clear);
    };
  }, [pathname, invitationId]);

  async function issue() {
    if (busy) return;
    const current = ++generation.current;
    setBusy(true);
    setLink(null);
    setCopied(false);
    setError("");
    let resolveLink: (url: string) => void = () => {};
    let rejectLink: (error: unknown) => void = () => {};
    const pending = new Promise<string>((resolve, reject) => {
      resolveLink = resolve;
      rejectLink = reject;
    });
    const copying = startPortalCopy(pending, navigator.clipboard ?? {});
    try {
      const result = await actionIssueTeamInviteLink({ invitationId });
      if (current !== generation.current) {
        rejectLink(new Error("stale"));
        await copying;
        return;
      }
      if (!result.ok) {
        rejectLink(new Error("issue"));
        await copying;
        if (current === generation.current) setError(errorText(t, result.error));
        return;
      }
      resolveLink(result.url);
      const clipboard = await copying;
      if (current !== generation.current) return;
      setLink({ url: result.url, expiresAt: result.expiresAt, email: result.email });
      setCopied(clipboard.ok);
      if (!clipboard.ok) setError(t("i_team_invite_copy_failed"));
    } catch {
      rejectLink(new Error("issue"));
      await copying.catch(() => undefined);
      if (current === generation.current) setError(t("i_generic"));
    } finally {
      if (current === generation.current) setBusy(false);
    }
  }

  return (
    <div className="col">
      <button className="btn sm" type="button" disabled={busy} aria-busy={busy || undefined} onClick={() => void issue()}>
        {t("i_team_invite_copy")}
      </button>
      <p className="small muted">{t("i_team_invite_rotates")}</p>
      {error ? <p className="small" role="alert">{error}</p> : null}
      {link ? <TeamInviteLinkDisplay link={link} initiallyCopied={copied} /> : null}
    </div>
  );
}
