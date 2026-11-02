/* eslint-disable @next/next/no-img-element -- Private evidence must bypass the shared image optimizer. */
import { randomUUID } from "node:crypto";
import { handoverCopy } from "@/i18n/handover";
import { readHandover } from "@/server/handover";
import type { Session } from "@/server/types";
import { HandoverDiscard, HandoverForm, HandoverUpload } from "./handover-upload";
import { HandoverComparison, type ComparisonVersion } from "./handover-comparison";

export async function HandoverPage({ session, leaseId }: { session: Session; leaseId: string }) {
  const data = await readHandover(session, leaseId); const copy = handoverCopy(session.locale);
  const stamp = (value: Date | string) => new Intl.DateTimeFormat(session.locale, { dateStyle:"medium",timeStyle:"short",timeZone:"UTC" }).format(new Date(value)) + " (UTC)";
  const comparison: ComparisonVersion[] = data.versions.filter(v => v.phase === "move_in" || v.phase === "move_out").map(v => ({
    id:v.version_id, phase:v.phase, revision:v.revision, publishedAt:new Date(v.created_at).toISOString(), author:v.author_name,
    files:data.attachments.filter(a => a.version_id === v.version_id).map(a => ({id:a.id,name:a.file_name,mime:a.mime,uploadedAt:new Date(a.created_at).toISOString(),uploader:a.uploader_name})),
  }));
  return <div><h1>{copy.title}</h1>
    {data.intents.length > 0 && <section className="card pad" style={{marginBottom:16}}><h2>{copy.pending}</h2>{data.intents.map(i => <div key={i.id} className="fg"><p>{i.file_name}{i.status === "discarded" ? ` — ${copy.discarded}` : i.status === "attached" ? ` — ${copy.attached}` : ""}</p>{i.can_resume && <HandoverUpload leaseId={leaseId} versionId={i.version_id} locale={session.locale} existingIntent={i.id} />}<HandoverDiscard leaseId={leaseId} intentId={i.id} locale={session.locale} /></div>)}</section>}
    <HandoverComparison key={leaseId.toLowerCase()} leaseId={leaseId.toLowerCase()} locale={session.locale} versions={comparison} />
    <div className="grid2">{(["move_in", "move_out"] as const).map(phase => {
      const versions = data.versions.filter(v => v.phase === phase); const current = versions[0];
      return <section key={phase} className="card pad" aria-label={phase === "move_in" ? copy.in : copy.out}><h2>{phase === "move_in" ? copy.in : copy.out}</h2>
        {!current && <p>{copy.empty}</p>}
        {session.kind === "staff" && <HandoverForm leaseId={leaseId} phase={phase} versionId={current?.version_id ?? ""} locale={session.locale} note={current?.note ?? ""} />}
        {current && <HandoverUpload leaseId={leaseId} versionId={current.version_id} locale={session.locale} />}
        <h3>{copy.versions}</h3>{versions.map(v => <article key={v.version_id} className="card pad" style={{marginBottom:12,overflowWrap:"anywhere"}} data-current={v.version_id === current?.version_id ? "true" : "false"}><h4>{copy.version} {v.revision}</h4><p className="small muted">{copy.authored}: {v.author_name || copy.unknownActor} {copy.at} <time dateTime={new Date(v.created_at).toISOString()}>{stamp(v.created_at)}</time></p><p style={{whiteSpace:"pre-wrap"}}>{v.note}</p>
          <ul>{data.attachments.filter(a => a.version_id === v.version_id).map(a => <li key={a.id}><a href={`/api/handover/${leaseId}/${a.id}`}>{a.file_name}</a> — {copy.uploadedBy}: {a.uploader_name || copy.unknownActor} {copy.at} <time dateTime={new Date(a.created_at).toISOString()}>{stamp(a.created_at)}</time>{a.mime.startsWith("image/") && <img src={`/api/handover/${leaseId}/${a.id}`} alt={a.file_name} style={{display:"block",maxWidth:"100%",maxHeight:240}} />}</li>)}</ul>
          <h5>{copy.replies}</h5><ul>{data.replies.filter(r => r.version_id === v.version_id).map((r, index) => <li data-testid="handover-reply" key={index}>{r.actor_name || (r.actor_kind === "staff" ? copy.staff : copy.tenant)}: {r.response === "confirm" ? copy.confirm : copy.disagree}{r.note ? ` — ${r.note}` : ""} {copy.at} <time dateTime={new Date(r.created_at).toISOString()}>{stamp(r.created_at)}</time></li>)}</ul>
          {v.version_id === current?.version_id && <HandoverForm leaseId={leaseId} versionId={v.version_id} requestId={randomUUID()} locale={session.locale} />}
        </article>)}
      </section>;
    })}</div>
  </div>;
}
