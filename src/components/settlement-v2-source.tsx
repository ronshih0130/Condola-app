import React from "react";
import { settlementV2Copy,settlementV2Charge } from "@/i18n/settlement-v2";
import type { validateV2UnknownSnapshot } from "@/server/settlement-v2-schema";
type Projection=ReturnType<typeof validateV2UnknownSnapshot>["projection"];
/** Immutable, unverified staff observation. Amounts remain labeled raw minor units. */
export function SettlementV2Source({projection,locale}:{projection:Projection;locale:string}) {
 const c=settlementV2Copy(locale),amount=(value:string|null,currency:string)=>value===null?c.unavailable:`${value} ${c.minor} (${currency})`;
 return <section className="card pad"><h2>{c.title}</h2><p className="alert warn">{c.notice}</p>
  <h3>{c.cycle}</h3>{projection.cycles.length?<ul>{projection.cycles.map((cycle,i)=><li key={i}>{cycle.periodStart} – {cycle.periodEnd}: {amount(cycle.monthlyMinor,cycle.currency)}</li>)}</ul>:<p>{c.empty}</p>}
  <h3>{c.rentCash}</h3>{projection.cash.length?<ul>{projection.cash.map((cash,i)=><li key={i}>{cash.kind==="payment"?c.payment:c.external}: {amount(cash.amountMinor,cash.currency)} — {c.sourceUnknown}</li>)}</ul>:<p>{c.empty}</p>}
  <h3>{c.lines}</h3>{projection.lines.length?<ul>{projection.lines.map((line,i)=><li key={i}>{line.invoiceNumber??c.unavailable} — {line.description}<div>{c.type}: {settlementV2Charge(locale,line.chargeType)}; {c.lineAmount}: {amount(line.amountMinor,line.currency)}; {c.period}: {line.period??c.unavailable}; {c.invoiceStatus}: {line.status??c.unavailable}; {c.invoiceBalance}: {amount(line.balanceMinor,line.currency)}; {line.classification==="rent"?c.rent:line.classification==="related_adjustment"?c.adjustment:line.classification==="unrelated"?c.unrelated:c.unavailable}</div></li>)}</ul>:<p>{c.empty}</p>}
 </section>;
}
