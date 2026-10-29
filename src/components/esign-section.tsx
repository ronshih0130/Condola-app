import type { ReactNode } from "react";
import { actionEsignCreate, actionEsignStep } from "@/server/esign/actions";
import type { LeaseView, VersionView } from "@/server/esign/flow";
import { esignCopy } from "@/server/esign/copy";
import { esignUi } from "@/i18n/lanes/esign";
import { EsignReview } from "./esign-review";
import { EsignSign } from "./esign-sign";
import { EsignNotice } from "./esign-notice";
import { EsignVersions } from "./esign-versions";

function Step({ version, step, children }: { version: VersionView; step: string; children: ReactNode }) {
  return <form action={actionEsignStep} style={{ marginBlock: 12, minWidth: 0 }}>
    <input type="hidden" name="caseId" value={version.caseId} />
    <input type="hidden" name="versionId" value={version.id} />
    <input type="hidden" name="step" value={step} />
    {children}
  </form>;
}

export function EsignSection({ view, locale }: { view: LeaseView; locale: "zh-TW" | "en" }) {
  const c = esignUi[locale], copy = esignCopy[locale];
  const ready = view.candidates.some((s) => s.role === "owner") && view.candidates.some((s) => s.role === "tenant");
  const state = (key: string) => c[key as keyof typeof c] ?? key;
  return <section className="card pad" data-testid="esign-flow"
    style={{ minWidth: 0, maxWidth: "100%", overflowWrap: "anywhere", marginBlock: 16 }}>
    <h3>{c.title}</h3><EsignNotice locale={locale} />
    {view.manage && !view.versions.length ? <>
      <p>{copy["ES-01"].empty}</p>
      {ready ? <form action={actionEsignCreate}>
        <input type="hidden" name="leaseId" value={view.leaseId} />
        <label style={{ display: "block" }}>{c.pdf}<input className="inp" style={{ maxWidth: "100%" }}
          type="file" name="pdf" accept="application/pdf,.pdf" required /></label>
        {(["owner", "tenant"] as const).map((role) => <div key={role}>
          <label>{c[role]}<select className="inp" name={role + "Id"} required>
            {view.candidates.filter((s) => s.role === role).map((s) => <option key={s.id} value={s.id}>{s.name} ({s.email})</option>)}
          </select></label>
          <label><input type="checkbox" name={role + "Document"} /> {c.foreign}</label>
        </div>)}
        <label>{c.order}<select className="inp" name="order"><option value="parallel">{c.parallel}</option><option value="sequential">{c.sequential}</option></select></label>
        <label>{c.deadline}<input className="inp" name="deadline" placeholder="2026-11-01T12:00:00+08:00" required /></label>
        <p>{copy["ES-02"].help}</p><button className="btn" type="submit">{c.create}</button>
      </form> : <p>{c.emptySigners}</p>}
    </> : null}
    <EsignVersions locale={locale} filter={view.manage} statuses={view.versions.map((v) => v.status)}>{view.versions.map((v) => {
      const open = !["completed", "superseded", "voided"].includes(v.status);
      const url = "/api/esign/" + v.caseId + "/" + v.id;
      return <article key={v.id} style={{ borderTop: "1px solid #ccc", marginTop: 16, paddingTop: 12, minWidth: 0 }}>
        <h4>{view.manage ? copy["ES-07"].label : c.title}</h4>
        <p>{v.id} · {state(v.status === "sent" ? "sentStatus" : v.status)} · {state(v.effect === "effective" ? "current" : v.effect)}</p>
        {v.previousId ? <p>{c.previous}: {v.previousId}</p> : null}
        {v.replacementText ? <p>{v.replacementText}</p> : null}
        <ul>{v.participants.map((s, i) => <li key={i}>{c[s.role]}: {state(s.status)}</li>)}</ul>
        {v.halted ? <p role="status">{copy["ES-02"].halted}</p> : null}
        {v.own && open && !v.halted ? <>
          {v.own.status === "pending_consent" ? <>
            <h4>{copy["ES-02"].label}</h4><p>{c.company}: {view.company}</p>
            <p>{copy["ES-02"].help}</p><p>{c.explicit}</p><p>{c.deadline}: {v.own.deadline}</p>
            <Step version={v} step="consent"><button type="submit">{copy["ES-02"].agree}</button></Step>
          </> : null}
          <Step version={v} step="object"><button type="submit">{copy["ES-02"].object}</button></Step>
          {v.own.status === "pending_identity" ? <>
            <h4>{copy["ES-03"].label}</h4>
            {!v.own.challenge ? <Step version={v} step="email"><button type="submit">{c.send}</button></Step> : <>
              <p>{c.sent}</p>{v.own.identityFailed ? <p role="alert">{copy["ES-03"].error}</p> : null}
              <Step version={v} step="confirm"><label>{c.code}<input className="inp" name="response" autoComplete="one-time-code" required maxLength={128} /></label>
                <button type="submit">{c.confirm}</button></Step>
            </>}
          </> : null}
          {v.own.identityLabel ? <p>{v.own.identityLabel}</p> : null}
          {v.own.status === "pending_review" ? <EsignReview key={v.id} caseId={v.caseId} versionId={v.id} pages={v.pages} locale={locale} /> : null}
          {v.own.documentCheckPending ? <p>{c.pendingDocument}</p> : null}
          {v.own.status === "pending_signature" && !v.own.documentCheckPending ?
            <EsignSign caseId={v.caseId} versionId={v.id} digest={v.digest} locale={locale} /> : null}
        </> : null}
        {v.own?.signedAt ? <div><h4>{copy["ES-06"].label}</h4><p>{copy["ES-06"].completed} · {v.own.signedAt}</p>
          <p>{v.status === "completed" ? copy["ES-06"].allCompleted : copy["ES-06"].waiting}</p></div> : null}
        <h4>{copy["ES-08"].label}</h4><p>{copy["ES-08"].readonly}</p>
        <p>{copy["ES-08"].digest}: <code style={{ wordBreak: "break-all" }}>{v.digest}</code></p>
        <a href={url} target="_blank" rel="noreferrer">{copy["ES-04"].label} · {c.download}</a>
        {["completed", "superseded"].includes(v.status) ? <p><a href={url + "?final=1"} target="_blank" rel="noreferrer">{c.download}</a></p> : <p>{copy["ES-08"].empty}</p>}
        {v.audit.map((a) => <div key={a.signerId}><p>{view.manage ? a.signerId : c.signer}: {a.identityLabel} {a.signedAt}</p>
          {view.manage && "ip" in a ? <dl><dt>IP</dt><dd>{a.ip}</dd><dt>Device</dt><dd>{a.device}</dd><dt>User-Agent</dt><dd>{a.userAgent}</dd></dl> : null}
        </div>)}
        {view.manage && v.history.length ? <pre style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere", maxWidth: "100%" }}>{JSON.stringify(v.history, null, 2)}</pre> : null}
        {view.manage && open && !v.halted ? <Step version={v} step="document">
          <h4>{copy["ES-03"].foreignDocument}</h4>
          <label>{c.signer}<select className="inp" name="signerId">{v.audit.filter((a) => a.status !== "completed").map((a) => <option key={a.signerId} value={a.signerId}>{a.signerId}</option>)}</select></label>
          <select className="inp" name="documentType"><option value="passport">{c.passport}</option><option value="residence_permit">{c.residence}</option></select>
          <button type="submit">{c.check}</button>
        </Step> : null}
        {view.admin && open ? <Step version={v} step="void"><h4>{copy["ES-09"].label}</h4>
          <p>{copy["ES-09"].incomplete}</p><label>{c.reason}<textarea className="inp" name="reason" required maxLength={2000} /></label>
          <button type="submit">{c.void}</button>
        </Step> : null}
        {view.manage && (v.status === "voided" || v.effect === "effective") ? <Step version={v} step="replace">
          <h4>{copy["ES-09"].label}</h4><p>{copy["ES-09"].effective}</p>
          <label>{c.body}<textarea className="inp" name="body" rows={10} required maxLength={50000} /></label>
          <label>{c.deadline}<input className="inp" name="deadline" placeholder="2026-11-01T12:00:00+08:00" required /></label>
          <button type="submit">{c.replace}</button>
        </Step> : null}
      </article>;
    })}</EsignVersions>
  </section>;
}
