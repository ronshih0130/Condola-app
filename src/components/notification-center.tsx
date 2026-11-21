import React from "react";
import { centerCopy } from "@/i18n/lanes/notification-center";
import type { Locale } from "@/i18n";
import type { CenterPage } from "@/server/notification-center";
import { NotificationMarkForm } from "./notification-mark-form";

export function NotificationCenterBusy({locale,retryHref}:{locale:Locale;retryHref:string}) {
  const copy=centerCopy(locale);
  return <div className="card pad" data-testid="notification-busy" role="status"><h1>{copy.title}</h1><p>{copy.busy}</p><a className="btn" style={{minHeight:44}} href={retryHref}>{copy.retry}</a></div>;
}
export function NotificationCenter({page,locale,kind,empty}:{page:CenterPage;locale:Locale;kind:"human"|"vendor";empty?:React.ReactNode}) {
  const copy=centerCopy(locale);
  const {items,continuation}=page;
  return <div className="card pad" data-testid="notification-center"><h1>{copy.title}</h1><p className="muted small">{copy.scope}</p>
    {items.length===0 ? empty ?? <p data-testid="notification-empty">{copy.empty}</p> : <ul>{items.map(item=><li key={item.recipient_id} data-testid="notification-item">
      <p>{copy.kinds[item.kind]}</p>
      {item.read_at ? <p className="small" data-testid="notification-read-state">{copy.read}</p> : page.readOnly ? <p className="small">{copy.unread}</p> : <NotificationMarkForm id={item.recipient_id} kind={kind} mark={copy.mark} unread={copy.unread} busy={copy.busy} unknown={copy.unknown}/>}
    </li>)}</ul>}
    {continuation ? <form method="get"><input type="hidden" name="cursor" value={continuation}/><button className="btn" style={{minHeight:44}} type="submit">{copy.next}</button></form> : null}
  </div>;
}
