"use client";
/* eslint-disable @next/next/no-img-element -- Authorized files must bypass the shared image optimizer. */
import { useState } from "react";
import { handoverComparisonCopy } from "@/i18n/handover";

export type ComparisonVersion = {
  id: string; phase: "move_in" | "move_out"; revision: number; publishedAt: string; author: string | null;
  files: { id: string; name: string; mime: string; uploadedAt: string; uploader: string | null }[];
};

function Phase({ phase, versions, leaseId, locale }: { phase: ComparisonVersion["phase"]; versions: ComparisonVersion[]; leaseId: string; locale: string }) {
  const c = handoverComparisonCopy(locale);
  const ordered = versions.filter(v => v.phase === phase).slice().sort((a,b) => b.revision-a.revision || a.id.localeCompare(b.id));
  const [selectedVersion, setSelectedVersion] = useState("");
  const [selectedPhoto, setSelectedPhoto] = useState("");
  const [imageState, setImageState] = useState<{ key: string; state: "loaded" | "error" } | null>(null);
  const version = ordered.find(v => v.id === selectedVersion) ?? ordered[0];
  const files = version?.files.slice().sort((a,b) => a.uploadedAt.localeCompare(b.uploadedAt) || a.id.localeCompare(b.id)) ?? [];
  const photos = files.filter(f => f.mime.startsWith("image/"));
  const photo = photos.find(f => `${version.id}:${f.id}` === selectedPhoto) ?? photos[0];
  const key = photo && version ? `${version.id}:${photo.id}` : "";
  const state = imageState?.key === key ? imageState.state : "loading";
  const label = phase === "move_in" ? c.moveIn : c.moveOut;
  const stamp = (value: string) => `${new Intl.DateTimeFormat(locale, {dateStyle:"medium",timeStyle:"short",timeZone:"UTC"}).format(new Date(value))} (UTC)`;
  const url = photo ? `/api/handover/${encodeURIComponent(leaseId)}/${encodeURIComponent(photo.id)}` : "";
  return <section role="group" className="card pad" aria-label={`${c.title}: ${label}`} data-testid={`comparison-${phase}`} style={{minWidth:0,overflowWrap:"anywhere"}}>
    <h3>{label}</h3>
    {!version ? <p>{c.noVersion}</p> : <>
      <label className="f">{c.version}<select className="inp" value={version.id} onChange={event => { setSelectedVersion(event.target.value); setSelectedPhoto(""); }}>
        {ordered.map(v => <option key={v.id} value={v.id}>{c.revision} {v.revision}</option>)}
      </select></label>
      <p>{c.published} {c.by} {version.author || c.unknown} {c.at} <time dateTime={version.publishedAt}>{stamp(version.publishedAt)}</time></p>
      {!photos.length ? <p>{files.length > 0 && files.every(f => f.mime === "application/pdf") ? c.pdfOnly : c.noPhotos}</p> : <>
        <label className="f">{c.photo}<select className="inp" value={key} onChange={event => setSelectedPhoto(event.target.value)}>
          {photos.map(f => <option key={`${version.id}:${f.id}`} value={`${version.id}:${f.id}`}>{f.name}</option>)}
        </select></label>
        <p>{c.uploaded} {c.by} {photo.uploader || c.unknown} {c.at} <time dateTime={photo.uploadedAt}>{stamp(photo.uploadedAt)}</time></p>
        {state === "loading" && <p role="status">{c.loading}</p>}{state === "error" && <p role="alert">{c.imageError}</p>}
        <img key={key} src={url} alt={`${label}: ${c.alt} — ${photo.name}`} onLoad={() => setImageState({key,state:"loaded"})} onError={() => setImageState({key,state:"error"})} style={{display:state === "error" ? "none" : "block",maxWidth:"100%",maxHeight:360,objectFit:"contain"}} />
        <a href={url}>{c.download}: {photo.name}</a>
      </>}
    </>}
  </section>;
}

export function HandoverComparison({ leaseId, locale, versions }: { leaseId: string; locale: string; versions: ComparisonVersion[] }) {
  const c = handoverComparisonCopy(locale);
  return <section className="card pad" data-testid="handover-comparison"><h2>{c.title}</h2><p>{c.description}</p><div className="grid2">
    <Phase key={`${leaseId}:move_in`} phase="move_in" versions={versions} leaseId={leaseId} locale={locale}/>
    <Phase key={`${leaseId}:move_out`} phase="move_out" versions={versions} leaseId={leaseId} locale={locale}/>
  </div></section>;
}
