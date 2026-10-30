"use client";
import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { afterBusyMark, notificationMarkResult, vendorTokenFromNotificationPath, type MarkDisplayState } from "./notification-mark-rules";

export type MarkState={status:"idle"|"busy"|"done"};
export function NotificationMarkForm({id,kind,mark,unread,busy,unknown}:{id:string;kind:"human"|"vendor";mark:string;unread:string;busy:string;unknown:string}) {
  const router=useRouter(),inFlight=useRef(false);
  const [state,setState]=useState<MarkDisplayState>("idle");
  const [pending,setPending]=useState(false);
  const [ready,setReady]=useState(false);
  useEffect(()=>{setReady(true);},[]);
  async function submit() {
    if(inFlight.current) return;inFlight.current=true;setPending(true);
    try {
      const token=kind==="vendor"?vendorTokenFromNotificationPath(window.location.pathname):null;
      if(kind==="vendor" && !token) {setState("unknown");return;}
      const body=kind==="vendor"?{recipientId:id,token}:{recipientId:id};
      const response=await fetch(kind==="vendor"?"/api/notification-center/vendor-mark":"/api/notification-center/mark",{
        method:"POST",headers:{"Content-Type":"application/json"},credentials:"same-origin",cache:"no-store",redirect:"error",body:JSON.stringify(body),
      });
      if(response.status!==200) {setState("unknown");return;}
      const result=notificationMarkResult(true,await response.json());
      if(result==="busy") {setState(afterBusyMark);return;}
      if(result==="marked") {setState("unknown");router.refresh();return;}
      setState("unknown");
    } catch {setState("unknown");} finally {inFlight.current=false;setPending(false);}
  }
  return <div><p className="small" data-testid="notification-read-state" role={state==="unknown" || state==="unknownBusy"?"alert":undefined}>{state==="unknown" || state==="unknownBusy"?unknown:unread}</p>
    <button className="btn" style={{minHeight:44}} data-testid="notification-mark" type="button" onClick={submit} disabled={!ready || pending}>{mark}</button>
    {(state==="busy" || state==="unknownBusy") ? <p role="status" data-testid="notification-mark-busy">{busy}</p> : null}
  </div>;
}
