import React from "react";
import { notFound } from "next/navigation";
import { brandProperty } from "../../../../server/b3-property";
import { staffInviteVisible, staffInviteEntries, staffInvitePath } from "../../../../server/b040-staff-ui";
import { FlowError, logServerError } from "../../../../server/errors";
import type { Session } from "../../../../server/types";
import { PropertyView } from "./property";
import { propertyDetail } from "../../../../server/queries";
import { actionSetMeter, actionPhoneVisibility } from "../../../../server/actions";

export async function PropertyV3Page({session,id,query}:{session:Session;id:string;query?:{error?:string;created?:string}}) {
  let data;
  let detail;
  let invites:{rowId:string;href:string}[]=[];
  try {
    data=await brandProperty(session,id);
    if(data.state==="ready") detail=await propertyDetail(session,id);
    if(data.state==="ready" && data.canInvite && await staffInviteVisible(session)) {
      // B-040 only addresses units. Whole-unit targets can reuse it exactly;
      // split-room independent invitations await their own backend, never send
      // every room to a shared four-seat pool disguised as independent invites.
      const targets=data.rows.filter(r=>r.kind==="whole_unit");
      if(targets.length) invites=(await staffInviteEntries(session,targets)).map(entry=>({rowId:entry.rowId,href:staffInvitePath(entry.unitId)}));
    }
  } catch(error) {
    const forbidden=error instanceof FlowError && error.key==="errors.forbidden";
    if(!forbidden)logServerError("b3_property_page",error);
    return <PropertyView data={{state:forbidden?"forbidden":"unavailable"}} locale={session.locale} id={id} />;
  }
  if(data.state==="not_found" || (data.state==="ready" && !detail)) notFound();
  return <PropertyView data={data} locale={session.locale} id={id} invites={invites} query={query}
    legacy={detail ? {session,detail,actionSetMeter,actionPhoneVisibility} : undefined} />;
}
