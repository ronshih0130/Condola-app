"use client";
import { useState } from "react";
import { renewalMajor,type RenewalInput,type RenewalTerms } from "@/lib/renewal-comparison";
import { renewalCopy } from "@/i18n/renewal";
import { compareRenewalAction } from "@/server/renewal-comparison-actions";
import { formatDate } from "@/server/format";
import { dictionary,type Locale } from "@/i18n";

type Result=Awaited<ReturnType<typeof compareRenewalAction>>;
export function RenewalComparison({leaseId,current,fingerprint,locale,calendar}:{leaseId:string;current:RenewalTerms;fingerprint:string;locale:Locale;calendar:"gregorian"|"roc"}) {
 const c=renewalCopy(locale);const [result,setResult]=useState<Result|null>(null),[busy,setBusy]=useState(false);
 const [fields,setFields]=useState<RenewalInput>({startDate:current.startDate,endMode:current.endDate?'date':'open_ended',endDate:current.endDate??"",rent:renewalMajor(current.rentMinor,current.minorUnit),frequency:current.frequency,dueDay:String(current.dueDay),deposit:renewalMajor(current.depositMinor,current.minorUnit)});
 function change(key:keyof RenewalInput,value:string){setFields(v=>({...v,[key]:value,...(key==='endMode'&&value==='open_ended'?{endDate:''}:{})}));setResult(null);}
 const format=(t:RenewalTerms)=>({startDate:formatDate(t.startDate,locale,calendar,dictionary(locale)),endDate:t.endDate?formatDate(t.endDate,locale,calendar,dictionary(locale)):c.openEnd,rent:renewalMajor(t.rentMinor,t.minorUnit)+" "+t.currency,frequency:({monthly:c.monthly,quarterly:c.quarterly,yearly:c.yearly} as Record<string,string>)[t.frequency]??t.frequency,dueDay:t.dueDay===31?c.lastDay:String(t.dueDay),deposit:renewalMajor(t.depositMinor,t.minorUnit)+" "+t.currency});
 const rows=[['startDate',c.start],['endDate',c.end],['rent',c.rent],['frequency',c.frequency],['dueDay',c.due],['deposit',c.deposit]] as const;
 return <section className="card pad"><h1>{c.title}</h1><p>{c.intro}</p><p>{c.currency}: {current.currency}</p>
  <form onSubmit={async e=>{e.preventDefault();setBusy(true);setResult(null);try{setResult(await compareRenewalAction(leaseId,fingerprint,fields));}catch{setResult({state:"unavailable"});}finally{setBusy(false);}}}>
   <fieldset disabled={busy}><div className="grid2">{([['startDate',c.start,'date'],['endDate',c.end,'date'],['rent',c.rent,'text'],['deposit',c.deposit,'text']] as const).map(([key,label,type])=><label className="f" key={key}>{label}<input className="inp" type={type} disabled={key==='endDate'&&fields.endMode==='open_ended'} inputMode={type==='text'?'decimal':undefined} value={fields[key]} onChange={e=>change(key,e.target.value)} /></label>)}
   <label className="f">{c.endMode}<select className="inp" value={fields.endMode} onChange={e=>change('endMode',e.target.value)}><option value="date">{c.fixedEnd}</option><option value="open_ended">{c.openEnd}</option></select></label>
   <label className="f">{c.frequency}<select className="inp" value={fields.frequency} onChange={e=>change('frequency',e.target.value)}><option value="monthly">{c.monthly}</option><option value="quarterly">{c.quarterly}</option><option value="yearly">{c.yearly}</option></select></label>
   <label className="f">{c.due}<select className="inp" value={fields.dueDay} onChange={e=>change('dueDay',e.target.value)}>{Array.from({length:31},(_,i)=>i+1).map(n=><option key={n} value={n}>{n===31?c.lastDay:n}</option>)}</select></label></div>
   <button className="btn pri" disabled={busy}>{busy?c.loading:c.compare}</button></fieldset>{busy&&<p role="status">{c.loading}</p>}
  </form>
  {result && result.state!=="ready" && <p role="alert" className="alert warn">{result.state==='invalid'?c.invalid:result.state==='stale'?c.stale:c.unavailable}</p>}
  {result?.state==='ready' && <div data-testid="renewal-result"><p className={result.overlap?'alert warn':'alert'}>{result.overlap?c.conflict:c.clear}</p><p>{c.unsaved}</p>{result.diff.frequency&&<p>{c.freqNotice}</p>}<div style={{overflowX:'auto'}}><table className="t"><thead><tr><th></th><th>{c.current}</th><th>{c.proposed}</th><th></th></tr></thead><tbody>{rows.map(([key,label])=><tr key={key}><th>{label}</th><td>{format(result.current)[key]}</td><td>{format(result.proposed)[key]}</td><td>{result.diff[key]?c.changed:c.same}</td></tr>)}</tbody></table></div></div>}
 </section>;
}
