import React from "react";
import Link from "next/link";
import { makeT, type Locale } from "../../../../i18n";
import { propertyCopy } from "../../../../i18n/lanes/brand-v3-property";
import type { PropertyResult } from "../../../../server/b3-property";
import { displaySampleName } from "../../../../server/sandbox-data";
import { archiveCopy } from "../../../../i18n/record-archive";
import { EmptyState } from "../../../empty-state";
import { ErrorBanner } from "../../../ui";
import { PropertyLegacyControls, type LegacyPropertyControls } from "./legacy-controls";

export function PropertyLoading({locale}:{locale:Locale}) {
  const c=propertyCopy(locale);
  return <section className="v3-property" aria-busy="true" aria-label={c.loading}>
    <p role="status">{c.loading}</p><div className="v3-property-skeleton" aria-hidden="true" />
  </section>;
}
export function PropertyView({data,locale,id,invites=[],legacy,query={}}:{
  data:PropertyResult | {state:"forbidden"};locale:Locale;id:string;invites?:{rowId:string;href:string}[];
  legacy?:LegacyPropertyControls;query?:{error?:string;created?:string};
}) {
  const c=propertyCopy(locale);
  const t=makeT(locale);
  if(data.state!=="ready") return <section className="v3-property"><h1>{c.title}</h1>
    {data.state==="forbidden" ? <p role="status">{c.permission}</p> : <div role="alert"><p>{c.failed}</p>
      <Link className="btn" href={`/m/properties/${encodeURIComponent(id)}`}>{c.retry}</Link></div>}</section>;
  const values={name:displaySampleName(data.name),n:data.rooms,k:data.pending,occupied:data.occupied,rooms:data.rooms};
  const format=(text:string)=>text.replace(/\{(name|n|k|occupied|rooms)\}/g,(_,key:keyof typeof values)=>String(values[key]));
  return <section className="v3-property" data-testid="v3-property">
    <Link className="v3-property-back" href="/m/properties">{t("s_e03a6ec")}</Link>
    <header className="v3-property-lead"><h1>{format(data.unknown ? c.leadPartial : c.lead)}</h1>
      {data.rooms>0 && <p className="num">{format(c.occupancy)}</p>}
      {data.unknown>0 && <p>{c.incomplete}</p>}
      {data.archived && <p>{archiveCopy(locale).archived}</p>}
    </header>
    {query.created === "1" && <p className="alert ok" data-testid="property-created">{t("i_created_prop")}</p>}
    <ErrorBanner t={t} error={query.error} />
    {!data.rows.length ? <div className="v3-property-card v3-property-empty"><EmptyState id="UNIT" locale={locale} /></div> :
      <div className="v3-property-card"><table className="v3-property-table">
        <thead><tr><th scope="col">{c.room}</th><th scope="col">{c.type}</th><th scope="col">{c.status}</th><th scope="col">{c.pending}</th>
          {data.canInvite && invites.length>0 && <th scope="col">{c.invite}</th>}</tr></thead>
        <tbody>{data.rows.map(row=>{
          const invite=data.canInvite && !data.archived ? invites.find(i=>i.rowId===row.id) : undefined;
          const roomType=row.kind==="whole_unit" ? c.whole : c[row.roomType as "suite"|"shared_bath"|"studio"|"other"|"whole_home"] ?? c.unspecified;
          const leases=row.kind==="room" ? legacy?.detail.rooms.filter(room=>room.id===row.id && room.lease_id) : [];
          return <tr key={row.id}>
            <th scope="row">{row.kind==="room" && <span className="v3-property-unit">{displaySampleName(row.unitLabel)}</span>}
              {displaySampleName(row.label.trim()) || c.whole}
              {leases?.map((room,index)=><Link className="v3-property-room-lease" key={`${room.lease_id}-${index}`} href={`/m/leases/${room.lease_id}`}>{displaySampleName(room.tenant || "")}</Link>)}</th>
            <td data-label={c.type}>{roomType}</td><td data-label={c.status}><span className="v3-property-badge">{c[row.status]}</span></td>
            <td data-label={c.pending}><details open={row.pending.length>0 || row.unknown.length>0}>
              <summary>{row.unknown.length ? c.unknown : row.pending.length ? `${c.pending} ${row.pending.length}` : c.done}</summary>
              <ul aria-label={c.details}>{row.tasks.map(task=><li key={task.key}>
                {c.tasks[task.key]} · {task.ready===null ? c.unknown : task.ready ? c.complete : c.pending}
              </li>)}</ul>
            </details></td>
            {data.canInvite && invites.length>0 && <td>{invite && <a className="btn" href={invite.href} aria-label={`${row.unitLabel} ${row.label || c.whole} ${c.invite}`}>{c.invite}</a>}</td>}
          </tr>;
        })}</tbody>
      </table></div>}
    {legacy && <PropertyLegacyControls {...legacy} />}
    {/* Legacy controls keep their shipped labels until their v3 homes exist.
        No existing bulk action exists; scoped form outlines keep zero solid primaries. */}
  </section>;
}
