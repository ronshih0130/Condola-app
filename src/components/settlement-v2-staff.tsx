import { settlementV2CommandCopy,settlementV2Copy } from "@/i18n/settlement-v2";
import { SettlementV2Source } from "./settlement-v2-source";
import { SettlementV2Editor } from "./settlement-v2-editor";
import type { V2Scope } from "./settlement-v2-storage";
import type { loadV2Unknown } from "@/server/settlement-v2-staff";
type View=Awaited<ReturnType<typeof loadV2Unknown>>;
type File={id:string;file_name:string};
type Attr={id:string;kind:string;amount_minor:string;file_name:string};
export function SettlementV2Staff({view,scope,locale,versionId,editable,files,attributions}:{view:View;scope:V2Scope;locale:string;versionId:string;editable:boolean;files:File[];attributions:Attr[]}) {
 const c=settlementV2CommandCopy(locale),units=settlementV2Copy(locale).minor,currency=view.sourceProjection.statementCurrency,stamp=(value:Date|string)=>new Intl.DateTimeFormat(locale,{dateStyle:"medium",timeStyle:"short",timeZone:"UTC"}).format(new Date(value))+" (UTC)";
 return <div><section className="card pad"><h2>{c.draft}</h2><p className="alert warn">{c.unknown}</p><p>{view.freshness==="current"?c.current:view.freshness==="stale"?c.stale:c.freshnessUnavailable}</p><h3>{c.source}</h3>{view.provenance.map((p,i)=><p key={i}>{p.kind==="payment"?c.payment:c.external}: {p.amountMinor} {units} ({p.currency})</p>)}{view.items.map(item=><div key={item.item_key} className="card pad"><strong>{item.label}</strong><p>{c.amount}: {item.amount_minor} {units} ({currency})</p><p>{c.original}: {item.original_minor} {units} ({currency}); {c.previous}: {item.prior_minor??item.original_minor} {units} ({currency}); {c.adjustment}: {item.adjustment_minor} {units} ({currency})</p><p>{c.reason}: {item.reason}</p><p>{item.author_name||c.unknownPerson} {c.at} <time dateTime={new Date(item.created_at).toISOString()}>{stamp(item.created_at)}</time></p>{files.filter(file=>file.id===item.evidence_id).map(file=><a key={file.id} href={`/api/settlements/${scope.leaseId}/${versionId}/${file.id}`}>{c.evidence}: {file.file_name}</a>)}</div>)}</section><SettlementV2Source projection={view.sourceProjection} locale={locale}/><SettlementV2Editor scope={scope} locale={locale} currency={currency} expectedVersion={versionId} initial={view.editorInput} files={files} attributions={attributions} editable={editable}/></div>;
}
