import { centerCopy } from "@/i18n/lanes/notification-center";
import type { Locale } from "@/i18n";
import type { CenterPage } from "@/server/notification-center";
import { NotificationMarkForm, type MarkAction } from "./notification-mark-form";

export function NotificationCenterBusy({locale,retryHref}:{locale:Locale;retryHref:string}) {
  const copy=centerCopy(locale);
  return <div className="card pad" data-testid="notification-busy" role="status"><h1>{copy.title}</h1><p>{copy.busy}</p><a className="btn" style={{minHeight:44}} href={retryHref}>{copy.retry}</a></div>;
}
export function NotificationCenter({page,locale,mark}:{page:CenterPage;locale:Locale;mark:MarkAction}) {
  const copy=centerCopy(locale);
  const {items,continuation}=page;
  return <div className="card pad" data-testid="notification-center"><h1>{copy.title}</h1><p className="muted small">{copy.scope}</p>
    {items.length===0 ? <p data-testid="notification-empty">{copy.empty}</p> : <ul>{items.map(item=><li key={item.recipient_id} data-testid="notification-item">
      <p>{copy.kinds[item.kind]}</p><p className="small" data-testid="notification-read-state">{item.read_at ? copy.read : copy.unread}</p>
      {!item.read_at ? <NotificationMarkForm id={item.recipient_id} action={mark} mark={copy.mark} busy={copy.busy}/> : null}
    </li>)}</ul>}
    {continuation ? <form method="get"><input type="hidden" name="cursor" value={continuation}/><button className="btn" style={{minHeight:44}} type="submit">{copy.next}</button></form> : null}
  </div>;
}
