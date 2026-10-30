"use client";
import { useRef, useState } from "react";
import { publishHandoverAction, replyHandoverAction } from "@/server/handover-actions";
import { useRouter } from "next/navigation";
import { handoverCopy } from "@/i18n/handover";

export function HandoverUpload({ leaseId, versionId, locale, existingIntent }: { leaseId: string; versionId: string; locale: string; existingIntent?: string }) {
  const [file, setFile] = useState<File | null>(null); const [busy, setBusy] = useState(false); const [error, setError] = useState(false);
  const router = useRouter(); const copy = handoverCopy(locale); const base = `/api/handover/${encodeURIComponent(leaseId)}`;
  async function upload() {
    if (!file || busy) return;
    setBusy(true); setError(false); let intent = existingIntent ?? "";
    try {
      if (!intent) {
      const prepared = await fetch(base, { method:"POST", headers:{"Content-Type":"application/json"}, body:JSON.stringify({operation:"prepare", versionId, fileName:file.name, mime:file.type, size:file.size}) });
      if (!prepared.ok) throw new Error();
      const data = await prepared.json() as { intentId?: string }; intent = data.intentId ?? ""; if (!intent) throw new Error();
      }
      const stored = await fetch(`${base}?intent=${encodeURIComponent(intent)}`, { method:"PUT", body:file, headers:{"Content-Type":file.type} });
      if (!stored.ok) throw new Error();
      const saved = await fetch(base, { method:"POST", headers:{"Content-Type":"application/json"}, body:JSON.stringify({operation:"finalize", intentId:intent}) });
      if (!saved.ok) throw new Error();
      setFile(null); router.refresh();
    } catch { setError(true); }
    finally { setBusy(false); }
  }
  return <div className="fg"><label className="f">{copy.choose} <input className="inp" type="file" accept="image/jpeg,image/png,image/webp,application/pdf" onChange={event => setFile(event.target.files?.[0] ?? null)} /></label> <button className="btn pri" type="button" disabled={!file || busy} onClick={upload}>{busy ? copy.uploading : copy.upload}</button>{error && <p role="alert" className="alert bad">{copy.failed}</p>}</div>;
}

export function HandoverDiscard({ leaseId, intentId, locale }: { leaseId: string; intentId: string; locale: string }) {
  const [busy,setBusy] = useState(false); const [error,setError] = useState(false); const router = useRouter(); const copy = handoverCopy(locale);
  async function discard() {
    setBusy(true); setError(false);
    try { const result = await fetch(`/api/handover/${encodeURIComponent(leaseId)}`, { method:"POST", headers:{"Content-Type":"application/json"}, body:JSON.stringify({operation:"discard", intentId}) }); if (!result.ok) throw new Error(); router.refresh(); }
    catch { setError(true); } finally { setBusy(false); }
  }
  return <div><button className="btn" type="button" disabled={busy} onClick={discard}>{copy.discard}</button>{error && <p role="alert" className="alert bad">{copy.failed}</p>}</div>;
}

export function HandoverForm({ leaseId, phase, versionId, requestId, locale, note }: { leaseId:string; phase?:string; versionId:string; requestId?:string; locale:string; note?:string }) {
  const [busy,setBusy] = useState(false); const [error,setError] = useState(false); const guard=useRef(false); const router=useRouter(); const copy=handoverCopy(locale);
  return <form onSubmit={async event => {
    event.preventDefault(); if (guard.current) return; guard.current=true; setBusy(true); setError(false);
    const form=new FormData(event.currentTarget);
    try {
      const result=phase ? await publishHandoverAction(leaseId,phase,versionId,form) : await replyHandoverAction(leaseId,versionId,requestId ?? "",form);
      if (!result.ok) setError(true); else router.refresh();
    } catch { setError(true); } finally { guard.current=false; setBusy(false); }
  }}>
    {!phase && <><p className="small muted">{copy.details}</p><div className="fg"><label className="f">{copy.replies}<select className="inp" name="response" defaultValue="confirm"><option value="confirm">{copy.confirm}</option><option value="disagree">{copy.disagree}</option></select></label></div></>}
    <div className="fg"><label className="f">{copy.condition}<textarea className="inp" name="note" maxLength={phase ? 4000 : 2000} defaultValue={note ?? ""} /></label></div>
    {error && <p className="alert bad" role="alert">{copy.failed}</p>}
    <button className="btn pri" type="submit" disabled={busy}>{phase ? copy.save : copy.reply}</button>
  </form>;
}
