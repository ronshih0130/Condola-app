"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { actualMoveOutCopy } from "@/i18n/actual-moveout";
import { actionRecordMoveOut } from "@/server/b002-move-out-actions";

export function ActualMoveOut({ leaseId, currentDate, locale }: { leaseId: string; currentDate: string | null; locale: string }) {
  const copy = actualMoveOutCopy(locale);
  const router = useRouter();
  const [date, setDate] = useState(currentDate ?? "");
  const [savedDate, setSavedDate] = useState(currentDate);
  const [reason, setReason] = useState("");
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const guard = useRef(false);
  useEffect(() => { setDate(currentDate ?? ""); setSavedDate(currentDate); }, [currentDate]);

  return <form className="card pad" data-testid="actual-moveout" onSubmit={async (event) => {
    event.preventDefault();
    if (guard.current || !date || date === savedDate) return;
    guard.current = true; setPending(true); setMessage(null);
    try {
      const result = await actionRecordMoveOut(leaseId, date, reason);
      if (result.ok) {
        setSavedDate(date); setReason(""); setMessage({ ok:true, text:copy.saved }); router.refresh();
      } else {
        const text = result.reason === "invalid" ? copy.invalid : result.reason === "disabled" ? copy.disabled : result.reason === "forbidden" ? copy.forbidden : copy.missing;
        setMessage({ ok:false, text });
      }
    } catch {
      setMessage({ ok:false, text:copy.failed });
    } finally { guard.current=false; setPending(false); }
  }}>
    <h3>{copy.title}</h3>
    <p className="small">{copy.explanation}</p>
    <p data-testid="actual-moveout-current">{savedDate ? `${copy.current}: ${savedDate}` : copy.none}</p>
    {message ? <p role={message.ok ? "status" : "alert"} className={message.ok ? "alert ok" : "alert bad"} data-testid="actual-moveout-message">{message.text}</p> : null}
    <div className="fg"><label className="f" htmlFor="actual-moveout-date">{copy.date}</label><input id="actual-moveout-date" className="inp" type="date" required value={date} onChange={(event)=>setDate(event.target.value)} disabled={pending} data-testid="actual-moveout-date" /></div>
    <div className="fg"><label className="f" htmlFor="actual-moveout-reason">{copy.reason}</label><textarea id="actual-moveout-reason" className="inp" maxLength={500} value={reason} onChange={(event)=>setReason(event.target.value)} disabled={pending} data-testid="actual-moveout-reason" /></div>
    <p className="small muted">{copy.audit}</p>
    <button className="btn pri" type="submit" disabled={pending || !date || date === savedDate} data-testid="actual-moveout-submit">{pending ? copy.saving : copy.save}</button>
  </form>;
}
