import {can} from "../../../../server/perms";
import {ArchiveEntryV3} from '../archive/controls';
import {archiveScope} from '../../../../server/record-archive';
import React from "react";
import { notFound } from "next/navigation";
import { brandProperty } from "../../../../server/b3-property";
import { staffInviteVisible, staffInviteEntries, staffInvitePath } from "../../../../server/b040-staff-ui";
import { FlowError, logServerError } from "../../../../server/errors";
import type { Session } from "../../../../server/types";
import { PropertyView } from "./property";
import { propertyDetail } from "../../../../server/queries";
import { actionSetMeter, actionPhoneVisibility } from "../../../../server/actions";
import { AuditHistory } from "../../../audit-log";

export type PropertyQuery = {error?:string;audit?:string;created?:string};

export async function PropertyV3Page({session,id,query}:{session:Session;id:string;query:PropertyQuery}) {
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
    auditHistory={<AuditHistory table="properties" rowId={id} cursor={query.audit} path={`/m/properties/${id}`} preserve={{ error: query.error }} />}
    archiveEntries={detail ? Object.fromEntries(detail.byRoomUnits.map(unit=>[unit.id,<ArchiveEntryV3 key={unit.id} refValue={{kind:'unit',id:unit.id}} scope={archiveScope(session)} locale={session.locale} role={can(session,"props.edit")?session.role:null} archived={data.state==='ready'&&data.archived}/>])) : undefined}
    legacy={detail ? {session,detail,actionSetMeter,actionPhoneVisibility,archiveEntry:<ArchiveEntryV3 refValue={{kind:'property',id}} scope={archiveScope(session)} locale={session.locale} role={can(session,"props.edit")?session.role:null} archived={detail.property.archiveState==='archived'}/>} : undefined} />;
}
