"use client";
import { useActionState } from "react";

export type MarkState={status:"idle"|"busy"|"done"};
export type MarkAction=(state:MarkState,form:FormData)=>Promise<MarkState>;
export function NotificationMarkForm({id,action,mark,busy}:{id:string;action:MarkAction;mark:string;busy:string}) {
  const [state,submit,pending]=useActionState<MarkState,FormData>(action,{status:"idle"});
  return <form action={submit}><input type="hidden" name="recipientId" value={id}/>
    <button className="btn" style={{minHeight:44}} data-testid="notification-mark" type="submit" disabled={pending}>{mark}</button>
    {state.status==="busy" ? <p role="status" data-testid="notification-mark-busy">{busy}</p> : null}
  </form>;
}
