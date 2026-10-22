import { makeT, type Locale } from "@/i18n";
import { actionIssueLineCode, actionSetLineOptOut } from "@/server/actions";

export function LineLinkPanel({
  showLine,
  locale,
  sandbox,
  linked,
  optOut,
  code,
  qrSvg,
}: {
  showLine: boolean;
  locale: Locale;
  sandbox: boolean;
  linked: boolean;
  optOut: boolean;
  code: string | null;
  qrSvg: string | null;
}) {
  if (!showLine) return null;
  const t = makeT(locale);
  const fresh = Boolean(linked || code);
  return (
    <section className="card pad" data-testid="line-link-panel" style={{ marginTop: 16 }}>
      <h2>{showLine ? t("i_line_link_title") : null}</h2>
      <p className="small">{showLine ? t("i_line_link_help") : null}</p>
      {showLine && linked ? <p data-testid="line-linked">{t("i_line_linked")}</p> : null}
      {showLine && optOut ? (
        <p className="small" data-testid="line-opt-out-note">
          {showLine ? t("i_line_opt_out_note") : null}
        </p>
      ) : null}
      {showLine && code ? (
        <p>
          <span className="small">{showLine ? t("i_line_link_code") : null}</span>
          <br />
          <b data-testid="line-link-code">{code}</b>
        </p>
      ) : null}
      {showLine && qrSvg ? (
        <img
          data-testid="line-link-qr"
          alt={showLine ? t("i_line_link_code") : ""}
          src={`data:image/svg+xml;charset=utf-8,${encodeURIComponent(qrSvg)}`}
          width={180}
          height={180}
        />
      ) : null}
      <form action={actionIssueLineCode}>
        <button className="btn" type="submit" data-testid="line-link-new">
          {showLine ? t(fresh ? "i_line_link_again" : "i_line_link_new") : null}
        </button>
      </form>
      {showLine && !optOut ? (
        <form action={actionSetLineOptOut}>
          <input type="hidden" name="optOut" value="1" />
          <button className="btn" type="submit" data-testid="line-opt-out" style={{ marginTop: 8 }}>
            {showLine ? t("i_line_opt_out") : null}
          </button>
        </form>
      ) : null}
      {showLine && optOut ? (
        <form action={actionSetLineOptOut}>
          <input type="hidden" name="optOut" value="0" />
          <button className="btn" type="submit" data-testid="line-opt-in" style={{ marginTop: 8 }}>
            {showLine ? t("i_line_opt_in") : null}
          </button>
        </form>
      ) : null}
      {showLine && sandbox ? (
        <p className="small" data-testid="line-sandbox-note">
          {showLine ? t("i_line_sandbox_note") : null}
        </p>
      ) : null}
    </section>
  );
}
