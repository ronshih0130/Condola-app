import type { ReactNode } from "react";
import Link from "next/link";
import { makeT, type Locale } from "@/i18n";
import { directoryCopy } from "@/i18n/lanes/tenant-directory";
import type { DirectoryHistory, DirectoryResult } from "@/server/tenant-directory";
import { displaySampleName } from "@/server/sandbox-data";
import { AuditHistory } from "./audit-log";
import { ListPager,ListSearch,listSummary } from "./list-search";
import { PageHeader,statusClass,statusKey } from "./ui";

export function DirectoryUnavailable({locale,path}:{locale:Locale;path:string}) {
 const t=makeT(locale),copy=directoryCopy(locale);
 return <><PageHeader title={t("i_tenants_title")} /><div className="card"><p role="alert">{copy.unavailable}</p><a className="btn" href={path}>{copy.retry}</a></div></>;
}
function ContactText({email,phone,locale}:{email:string|null;phone:string|null;locale:Locale}) {
 return <span style={{overflowWrap:"anywhere"}}>{email?<span style={{display:"block"}}>{email}</span>:null}{phone?<span style={{display:"block"}}>{phone}</span>:null}{!email&&!phone?directoryCopy(locale).noContact:null}</span>;
}
export function TenantDirectoryList({locale,result,empty}:{locale:Locale;result:Extract<DirectoryResult,{state:"enabled"}>;empty?:ReactNode}) {
 const t=makeT(locale),copy=directoryCopy(locale),path="/m/tenants";
 return <><PageHeader title={t("i_tenants_title")} /><div className="card" data-testid="tenant-directory">
  <ListSearch action={path} q={result.q} label={t("i_search")} placeholder={t("i_search_ph_tenants")} clearLabel={t("i_search_clear")} />
  <table className="t rf"><thead><tr><th>{t("s_74f19b0")}</th><th>{t("i_space")}</th><th>{t("i_status")}</th>{result.canViewContact?<th>{copy.contact}</th>:null}</tr></thead><tbody>
   {result.rows.length===0?<tr><td colSpan={result.canViewContact?4:3}>{empty ?? copy.empty}</td></tr>:null}
   {result.rows.map(row=><tr key={row.contact_id} data-testid="directory-contact">
    <td data-label={t("s_74f19b0")}><Link className="hit" href={`/m/tenants/${row.contact_id}`}>{displaySampleName(row.name)}</Link></td>
    <td data-label={t("i_space")}>{row.latest_lease_id?<><Link href={`/m/leases/${row.latest_lease_id}`}>{displaySampleName(row.latest_place ?? "")}</Link>{row.lease_count>1?<span> +{row.lease_count-1} {copy.more}</span>:null}</>:copy.noLease}</td>
    <td data-label={t("i_status")}>{row.latest_status?<span className={`chip ${statusClass(row.latest_status)}`}>{t(statusKey(row.latest_status))}</span>:"—"}</td>
    {result.canViewContact?<td data-label={copy.contact}><ContactText email={row.email} phone={row.phone} locale={locale}/></td>:null}
   </tr>)}
  </tbody></table>
 </div><ListPager path={path} q={result.q} page={result.page} hasNext={result.hasNext} prevLabel={t("i_search_prev")} nextLabel={t("i_search_next")} summary={listSummary(t,result)} total={result.total} from={result.from} to={result.to}/></>;
}
export function TenantDirectoryDetail({locale,result,audit,empty}:{locale:Locale;result:Extract<DirectoryHistory,{state:"enabled"}>;audit?:string;empty?:ReactNode}) {
 const c=result.contact;if(!c) return null;
 const t=makeT(locale),copy=directoryCopy(locale),path=`/m/tenants/${c.contact_id}`;
 return <><PageHeader title={displaySampleName(c.name)} crumb={<Link href="/m/tenants">{t("i_tenants_title")}</Link>}/>
 {result.canViewContact?<div className="card"><div className="hd"><h3>{copy.contact}</h3></div><div style={{padding:16}}><ContactText email={c.email} phone={c.phone} locale={locale}/></div></div>:null}
 <div className="card" data-testid="directory-history"><div className="hd"><h3>{t("i_nav_leases")}</h3></div>
 {result.rows.length===0?<>{empty ?? <div className="empty">{copy.noLease}</div>}</>:<table className="t rf"><thead><tr><th>{t("i_space")}</th><th>{t("i_status")}</th></tr></thead><tbody>{result.rows.map(row=><tr key={row.id}><td><Link href={`/m/leases/${row.id}`}>{displaySampleName(row.place)}</Link></td><td data-label={t("i_status")}><span className={`chip ${statusClass(row.status)}`}>{t(statusKey(row.status))}</span></td></tr>)}</tbody></table>}
 </div><ListPager path={path} q="" page={result.page} hasNext={result.hasNext} prevLabel={t("i_search_prev")} nextLabel={t("i_search_next")} summary={listSummary(t,result)} total={result.total} from={result.from} to={result.to}/>
 <AuditHistory table="contacts" rowId={c.contact_id} cursor={audit} path={path}/></>;
}
