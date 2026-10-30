import { centerCopy } from "@/i18n/lanes/notification-center";
import type { Locale } from "@/i18n";
import type { CenterPage } from "@/server/notification-center";

export function NotificationCenter({page,locale,mark}:{page:CenterPage;locale:Locale;mark:(form:FormData)=>Promise<void>}) {
  const copy=centerCopy(locale);
  const {items,continuation}=page;
  return <div className="card pad" data-testid="notification-center"><h1>{copy.title}</h1><p className="muted small">{copy.scope}</p>
    {items.length===0 ? <p data-testid="notification-empty">{copy.empty}</p> : <ul>{items.map(item=><li key={item.recipient_id} data-testid="notification-item">
      <p>{copy.kinds[item.kind]}</p><p className="small" data-testid="notification-read-state">{item.read_at ? copy.read : copy.unread}</p>
      {!item.read_at ? <form action={mark}><input type="hidden" name="recipientId" value={item.recipient_id}/><button className="btn" style={{minHeight:44}} data-testid="notification-mark" type="submit">{copy.mark}</button></form> : null}
    </li>)}</ul>}
    {continuation ? <form method="get"><input type="hidden" name="cursor" value={continuation}/><button className="btn" style={{minHeight:44}} type="submit">{copy.next}</button></form> : null}
  </div>;
}
