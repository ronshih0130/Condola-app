import { paperLeaseCopy } from "@/i18n/paper-lease-versions";
import { listPaperLeaseVersions, REASON_MAX } from "./paper-lease-versions";
import { paperHistoryTime } from "./paper-lease-history-time";
import type { Session } from "./types";

export async function paperLeaseVersionPanel(
  session: Session,
  leaseId: string,
  action: (formData: FormData) => Promise<void>,
) {
  const versions = await listPaperLeaseVersions(session, leaseId);
  if (versions === null) return null;
  const copy = paperLeaseCopy(session.locale);
  const replacing = versions.length > 0;
  const canUpload = session.role === "admin" || session.role === "manager";
  return (
    <div style={{ marginTop: 16 }} data-testid="paper-sign">
      <h3>{copy.title}</h3>
      <p className="small muted">{copy.hint}</p>
      <ul data-testid="paper-version-history">
        {versions.map((version) => {
          const uploaded = paperHistoryTime(version.created_at, version.timezone, session.locale, session.calendar);
          return (
          <li key={version.id} data-current={version.current ? "true" : "false"}>
            <strong>
              {version.legacyFallback
                ? copy.currentLegacy
                : version.current ? copy.current : copy.history}
            </strong>{" "}
            <a href={`/m/leases/${leaseId}/signed/${version.id}`}>{version.file_name || copy.pdf}</a>
            <dl>
              <dt>{copy.uploadedAt}</dt>
              <dd>{uploaded ? <time dateTime={uploaded.iso}>{uploaded.label}</time> : copy.unavailable}</dd>
              <dt>{copy.uploader}</dt>
              <dd>{version.uploader_name ?? copy.unavailable}</dd>
              <dt>{copy.reason}</dt>
              <dd style={{ whiteSpace: "pre-wrap" }}>{version.replace_reason ?? copy.noReason}</dd>
            </dl>
          </li>
          );
        })}
      </ul>
      {canUpload ? (
        <form action={action}>
          <input type="hidden" name="leaseId" value={leaseId} />
          <input
            className="inp"
            type="file"
            name="signedPdf"
            accept="application/pdf,.pdf"
            data-testid="signed-pdf"
            required
          />
          {replacing ? (
            <div className="fg">
              <label className="f" htmlFor="paper-replace-reason">{copy.reason}</label>
              <textarea
                className="inp"
                id="paper-replace-reason"
                name="replaceReason"
                required
                maxLength={REASON_MAX}
                aria-describedby="paper-replace-reason-hint"
                data-testid="paper-replace-reason"
              />
              <p id="paper-replace-reason-hint" className="small muted">{copy.reasonInvalid}</p>
            </div>
          ) : null}
          <button className="btn" type="submit" data-testid="upload-signed-pdf" style={{ marginTop: 8 }}>
            {copy.upload}
          </button>
        </form>
      ) : null}
    </div>
  );
}
