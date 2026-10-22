"use client";

import { useEffect, useState } from "react";
import { actionIssueStaffLineCode, actionSaveLinePrefs, actionUnlinkStaffLine } from "@/server/actions";
import { useT } from "./locale";

const EVENTS = [
  { id: "rent_due", title: "i_ln_rent_due", help: "i_ln_rent_due_help" },
  { id: "rent_overdue", title: "i_ln_overdue", help: "i_ln_overdue_help" },
  { id: "lease_expiry", title: "i_ln_lease", help: "i_ln_lease_help" },
  { id: "repair", title: "i_ln_repair", help: "i_ln_repair_help" },
  { id: "statement", title: "i_ln_statement", help: "i_ln_statement_help" },
] as const;

const PREVIEWS = [
  { text: "i_ln_msg_rent", href: "/m/rent" },
  { text: "i_ln_msg_overdue", href: "/m/rent" },
  { text: "i_ln_msg_lease", href: "/m/leases" },
  { text: "i_ln_msg_repair", href: "/m/tickets" },
  { text: "i_ln_msg_statement", href: "/m/statements" },
] as const;

export function LineNotify({
  showLine,
  lineLive,
  status,
  linkedOn,
  code,
  qrSvg,
  deepLink,
  prefs,
  openLink,
  saved,
  unlinked,
  limit,
}: {
  showLine: boolean;
  lineLive: boolean;
  status: "unlinked" | "linked" | "blocked";
  linkedOn: string | null;
  code: string | null;
  qrSvg: string | null;
  deepLink: string | null;
  prefs: Record<string, boolean>;
  openLink: boolean;
  saved: boolean;
  unlinked: boolean;
  limit: boolean;
}) {
  const t = useT();
  const [linkOpen, setLinkOpen] = useState(openLink && status !== "linked");
  const [previewOpen, setPreviewOpen] = useState(false);
  const [unlinkOpen, setUnlinkOpen] = useState(false);
  const [toast, setToast] = useState<"saved" | "unlinked" | null>(saved ? "saved" : unlinked ? "unlinked" : null);
  const linked = status === "linked";

  useEffect(() => {
    if (!toast) return;
    const timer = window.setTimeout(() => setToast(null), 4000);
    return () => window.clearTimeout(timer);
  }, [toast]);

  useEffect(() => {
    if (linked) setLinkOpen(false);
  }, [linked]);

  useEffect(() => {
    if (!linkOpen || linked) return;
    const timer = window.setInterval(async () => {
      const response = await fetch("/api/line/link-status");
      if (!response.ok) return;
      const body = (await response.json()) as { status?: string };
      if (body.status === "linked" || body.status === "blocked") window.location.assign("/m/notify");
    }, 2000);
    return () => window.clearInterval(timer);
  }, [linkOpen, linked]);

  if (!showLine) return null;

  return (
    <div data-testid="line-notify">
      {showLine && !lineLive ? (
        <p className="alert" data-testid="line-notify-banner">
          {showLine ? t("i_ln_banner") : null}
        </p>
      ) : null}
      {showLine && limit ? (
        <p className="alert" data-testid="line-code-limit">
          {showLine ? t("i_ln_limit") : null}
        </p>
      ) : null}
      <section className="card pad" data-testid="line-link-card">
        <h2>{showLine ? t("i_ln_account") : null}</h2>
        <p data-testid="line-link-status">
          {linked ? (showLine ? t("i_ln_linked") : null) : status === "blocked" ? null : t("i_ln_unlinked")}
        </p>
        {status === "blocked" ? <p data-testid="line-link-blocked">{showLine ? t("i_ln_blocked") : null}</p> : null}
        {linked && linkedOn ? <p className="small">{t("i_ln_linked_on", { date: linkedOn })}</p> : null}
        {!linked ? (
          <form action={actionIssueStaffLineCode}>
            <button className="btn pri" type="submit" data-testid="line-link-open">
              {showLine ? t("i_ln_link") : null}
            </button>
          </form>
        ) : (
          <button className="btn" type="button" data-testid="line-unlink-open" onClick={() => setUnlinkOpen(true)}>
            {t("i_ln_unlink")}
          </button>
        )}
      </section>
      <section className="card pad" data-testid="line-notify-toggles" style={{ marginTop: 16 }}>
        <h2>{linked ? (showLine ? t("i_ln_which_line") : null) : t("i_ln_which")}</h2>
        {!linked ? <p className="small">{showLine ? t("i_ln_locked") : null}</p> : null}
        <form action={actionSaveLinePrefs}>
          <fieldset disabled={!linked} style={{ border: 0, padding: 0, margin: 0 }}>
            {EVENTS.map((event) => (
              <label className="radio" key={event.id}>
                <input type="checkbox" name="event" value={event.id} defaultChecked={prefs[event.id] !== false} />
                <span>
                  <b>{t(event.title)}</b>
                  <div className="small">{t(event.help)}</div>
                </span>
              </label>
            ))}
          </fieldset>
          {linked ? (
            <>
              <button className="btn pri" type="submit" data-testid="line-notify-save">
                {t("i_ln_save")}
              </button>
              <button className="btn" type="button" data-testid="line-preview-open" onClick={() => setPreviewOpen(true)} style={{ marginLeft: 8 }}>
                {t("i_ln_preview")}
              </button>
            </>
          ) : null}
        </form>
      </section>
      {linkOpen ? (
        <div className="modal-bg" data-testid="line-link-dialog">
          <div className="modal" role="dialog" aria-modal="true">
            <div className="hd">
              <b>{showLine ? t("i_ln_dialog") : null}</b>
            </div>
            <div className="bd">
              {code ? (
                <>
                  <ol>
                    <li>{t("i_ln_step1")}</li>
                    <li>{showLine ? t("i_ln_step2") : null}</li>
                    <li>{t("i_ln_step3")}</li>
                  </ol>
                  <p>{showLine ? t("i_ln_help") : null}</p>
                  <p className="small">{showLine ? t("i_ln_ttl") : null}</p>
                  <p>
                    <b data-testid="line-link-code">{code}</b>
                  </p>
                  {qrSvg ? (
                    <img
                      data-testid="line-link-qr"
                      alt={showLine ? t("i_ln_ttl") : ""}
                      src={`data:image/svg+xml;charset=utf-8,${encodeURIComponent(qrSvg)}`}
                      width={180}
                      height={180}
                    />
                  ) : null}
                  <p className="small">{t("i_ln_phone")}</p>
                  {deepLink ? (
                    <a className="btn" data-testid="line-open-app" href={deepLink}>
                      {showLine ? t("i_ln_open") : null}
                    </a>
                  ) : null}
                  <p className="small" data-testid="line-link-wait">
                    {t("i_ln_wait")}
                  </p>
                </>
              ) : (
                <p data-testid="line-link-error">{showLine ? t("i_ln_expired") : null}</p>
              )}
              <p className="small">{showLine ? t("i_ln_block_hint") : null}</p>
            </div>
            <div className="ft">
              <form action={actionIssueStaffLineCode}>
                <button className="btn pri" type="submit" data-testid="line-link-retry">
                  {showLine ? t("i_ln_retry") : null}
                </button>
              </form>
              <button className="btn" type="button" onClick={() => setLinkOpen(false)}>
                {t("i_ln_cancel")}
              </button>
            </div>
          </div>
        </div>
      ) : null}
      {previewOpen ? (
        <div className="modal-bg" data-testid="line-preview-dialog">
          <div className="modal" role="dialog" aria-modal="true">
            <div className="hd">
              <b>{t("i_ln_preview_title")}</b>
            </div>
            <div className="bd">
              <p>{showLine ? t("i_ln_preview_help") : null}</p>
              {PREVIEWS.map((item) => (
                <p key={item.href + item.text}>
                  {t(item.text)}{" "}
                  <a href={item.href}>{t("i_ln_view")}</a>
                </p>
              ))}
              <p className="small">{showLine ? t("i_ln_preview_foot") : null}</p>
            </div>
            <div className="ft">
              <button className="btn" type="button" onClick={() => setPreviewOpen(false)}>
                {t("i_ln_cancel")}
              </button>
            </div>
          </div>
        </div>
      ) : null}
      {unlinkOpen ? (
        <div className="modal-bg" data-testid="line-unlink-dialog">
          <div className="modal" role="dialog" aria-modal="true">
            <div className="hd">
              <b>{showLine ? t("i_ln_unlink_title") : null}</b>
            </div>
            <div className="bd">
              <p>{showLine ? t("i_ln_unlink_body") : null}</p>
            </div>
            <div className="ft">
              <form action={actionUnlinkStaffLine}>
                <button className="btn danger" type="submit" data-testid="line-unlink-confirm">
                  {t("i_ln_unlink")}
                </button>
              </form>
              <button className="btn" type="button" onClick={() => setUnlinkOpen(false)}>
                {t("i_ln_cancel")}
              </button>
            </div>
          </div>
        </div>
      ) : null}
      {toast ? (
        <p className="toast" role="status" data-testid={toast === "saved" ? "line-notify-saved" : "line-unlinked"}>
          {toast === "saved" ? t("i_ln_saved") : showLine ? t("i_ln_unlinked_toast") : null}
        </p>
      ) : null}
    </div>
  );
}
