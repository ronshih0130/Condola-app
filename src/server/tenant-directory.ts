import { guardEffectiveSession, withEffectiveAuthority } from "@/server/b017-custom-role-governance";
import { customRolesAdmitted, customRolesEnabledOn, customAuthorityAllowsOn, requireEffectivePerm } from "./b017-custom-role-governance";
import type { Client } from "pg";
import { tx } from "./db";
import { isUuid } from "./repair-rules";
import { ilikePattern, LIST_PAGE_SIZE, parseListQuery, slicePage, textSearch } from "./list-search";
import type { Session } from "./types";

/** Company contact identity, never an auth user or a synthesized lease identity. */
export type DirectoryContact = {
  contact_id: string;
  name: string;
  email: string | null;
  phone: string | null;
  latest_lease_id: string | null;
  latest_place: string | null;
  latest_status: string | null;
  lease_count: number;
};
type DirectoryPayload = { enabled:boolean; role:string; total:number; contacts:DirectoryContact[] };
export type DirectoryResult = {state:"disabled"|"unavailable"} | ({state:"enabled";q:string;page:number;canViewContact:boolean} & ReturnType<typeof slicePage<DirectoryContact>>);

// Read-only scope: no contact edits, auth linkage changes, archive or new grants.
// The actual member role controls fields/search, including when a Session's role
// value is stale. Every returned row is also read under authenticated RLS.
const CONTEXT_SQL = `context AS MATERIALIZED (
 SELECT o.id, m.role::text AS role,
   coalesce(o.feature_flags->'tenant_directory_edit'='true'::jsonb
    AND f.value->'enabled'='true'::jsonb
    AND jsonb_typeof(f.value->'allowed_org_ids')='array'
    AND f.value->'allowed_org_ids' @> jsonb_build_array(o.id::text),false) AS enabled
 FROM organizations o
 JOIN org_members m ON m.org_id=CASE WHEN o.environment='sandbox' THEN o.live_org_id ELSE o.id END
 JOIN auth_sessions s ON s.id=$3::uuid AND s.user_id=auth.uid()
 LEFT JOIN platform_settings f ON f.key='tenant_directory_edit'
 WHERE o.id=$1::uuid AND o.environment::text=$4 AND
  ((o.environment='live' AND o.id=$5::uuid AND o.live_org_id IS NULL)
   OR (o.environment='sandbox' AND o.live_org_id=$5::uuid))
  AND m.user_id=auth.uid() AND m.status='active' AND m.role IN ('admin','manager','accountant')
  AND s.revoked_at IS NULL AND s.expires_at>clock_timestamp()
)`;

const DIRECTORY_SQL = `WITH ${CONTEXT_SQL}, eligible AS MATERIALIZED (
 SELECT c.id::text AS contact_id,c.display_name AS name,
   CASE WHEN context.role IN ('admin','manager') THEN c.email::text END AS email,
   CASE WHEN context.role IN ('admin','manager') THEN c.phone_e164 END AS phone,
   history.latest_lease_id,history.latest_place,history.latest_status,
   coalesce(history.lease_count,0)::integer AS lease_count
 FROM contacts c CROSS JOIN context
 LEFT JOIN LATERAL (
  SELECT count(*)::integer AS lease_count,
    (array_agg(h.id::text ORDER BY h.created_at DESC,h.id DESC))[1] AS latest_lease_id,
    (array_agg(h.place ORDER BY h.created_at DESC,h.id DESC))[1] AS latest_place,
    (array_agg(h.status ORDER BY h.created_at DESC,h.id DESC))[1] AS latest_status
  FROM (
   SELECT DISTINCT l.id,l.created_at,l.status::text,
     p.name || ' ' || u.label || coalesce(' ' || r.label,'') AS place
   FROM lease_parties lp JOIN leases l ON l.org_id=lp.org_id AND l.id=lp.lease_id
   JOIN properties p ON p.org_id=l.org_id AND p.id=l.property_id
   JOIN units u ON u.org_id=l.org_id AND u.id=l.unit_id
   LEFT JOIN rooms r ON r.org_id=l.org_id AND r.id=l.target_room_id
   WHERE lp.org_id=c.org_id AND lp.contact_id=c.id AND lp.role IN ('primary','co_tenant')
  ) h
 ) history ON true
 WHERE context.enabled AND c.org_id=$1::uuid AND c.is_tenant AND c.archived_at IS NULL
 AND ($2::text IS NULL OR ${textSearch(["c.display_name", "coalesce(c.legal_name, '')"])}
   OR (context.role IN ('admin','manager') AND (${textSearch(["coalesce(c.email::text, '')", "coalesce(c.phone_e164, '')"])})))
), paged AS (
 SELECT * FROM eligible ORDER BY name,contact_id LIMIT $6::integer OFFSET $7::integer
)
SELECT context.enabled,context.role,(SELECT count(*)::integer FROM eligible) AS total,
 coalesce((SELECT jsonb_agg(to_jsonb(paged) ORDER BY name,contact_id) FROM paged),'[]'::jsonb) AS contacts
FROM context`;

async function directorySql(client: Client, session: Session, sql: string): Promise<{ sql: string; contact: boolean | null }> {
  if (!session.customRole && (!customRolesAdmitted(session.orgId) || !await customRolesEnabledOn(client, session.orgId))) return { sql, contact: null };
  await requireEffectivePerm(client, session, "props.view");
  const contact = await customAuthorityAllowsOn(client, session, "tenants.contact");
  // Filter contact searches in SQL, before pagination/counting; DTO masking alone leaks matches.
  return { sql: contact ? sql : sql.replaceAll("context.role IN ('admin','manager')", "false"), contact };
}

export async function tenantDirectory(session:Session,raw?:{q?:string;page?:string|number;limit?:number}):Promise<DirectoryResult> {
  session = await guardEffectiveSession(session, "props.view");
  if(session.kind!=="staff" || session.needsSandbox || ![session.orgId,session.liveOrgId,session.userId,session.sessionId].every(isUuid) || !["live","sandbox"].includes(session.environment)) return {state:"unavailable"};
  const {q,page}=parseListQuery(raw);
  const limit=Number.isInteger(raw?.limit) && (raw?.limit ?? 0)>0 ? Math.min(raw!.limit!,100) : LIST_PAGE_SIZE;
  let contact: boolean | null = null;
  const payload=await tx(session.userId,async c=>withEffectiveAuthority(c, session, "props.view", async () => {
    const authority = await directorySql(c,session,DIRECTORY_SQL); contact = authority.contact;
    return (await c.query<DirectoryPayload>(authority.sql,[session.orgId,ilikePattern(q),session.sessionId,session.environment,session.liveOrgId,limit+1,(page-1)*limit])).rows[0];
  }),{orgId:session.orgId,environment:session.environment});
  if(!payload) return {state:"unavailable"};
  if(!payload.enabled) return {state:"disabled"};
  return {state:"enabled",q,page,canViewContact:contact ?? ["admin","manager"].includes(payload.role),...slicePage(payload.contacts,limit,payload.total,page)};
}


export type DirectoryLease = {id:string;place:string;status:string};
type HistoryPayload = {enabled:boolean;role:string;contact:DirectoryContact|null;total:number;leases:DirectoryLease[]};
export type DirectoryHistory = {state:"disabled"|"unavailable"} | ({state:"enabled";contact:DirectoryContact|null;canViewContact:boolean;page:number} & ReturnType<typeof slicePage<DirectoryLease>>);
const HISTORY_SQL = `WITH ${CONTEXT_SQL}, visible_contact AS MATERIALIZED (
 SELECT c.* FROM contacts c CROSS JOIN context WHERE context.enabled AND c.org_id=$1::uuid AND c.id=$2::uuid AND c.is_tenant AND c.archived_at IS NULL
), history AS MATERIALIZED (
 SELECT DISTINCT l.id::text,l.created_at,l.status::text,
  p.name || ' ' || u.label || coalesce(' ' || r.label,'') AS place
 FROM lease_parties lp JOIN visible_contact c ON c.org_id=lp.org_id AND c.id=lp.contact_id
 JOIN leases l ON l.id=lp.lease_id AND l.org_id=lp.org_id
 JOIN properties p ON p.id=l.property_id AND p.org_id=l.org_id
 JOIN units u ON u.id=l.unit_id AND u.org_id=l.org_id
 LEFT JOIN rooms r ON r.id=l.target_room_id AND r.org_id=l.org_id
 WHERE lp.role IN ('primary','co_tenant')
), paged AS (SELECT id,place,status,created_at FROM history ORDER BY created_at DESC,id DESC LIMIT $6::integer OFFSET $7::integer)
SELECT context.enabled,context.role,(SELECT count(*)::integer FROM history) AS total,
 (SELECT jsonb_build_object('contact_id',c.id::text,'name',c.display_name,
  'email',CASE WHEN context.role IN ('admin','manager') THEN c.email::text END,
  'phone',CASE WHEN context.role IN ('admin','manager') THEN c.phone_e164 END,
  'latest_lease_id',NULL,'latest_place',NULL,'latest_status',NULL,'lease_count',(SELECT count(*) FROM history)) FROM visible_contact c) AS contact,
 coalesce((SELECT jsonb_agg(jsonb_build_object('id',id,'place',place,'status',status) ORDER BY created_at DESC,id DESC) FROM paged),'[]'::jsonb) AS leases
FROM context`;

export async function tenantDirectoryHistory(session:Session,contactId:string,raw?:{page?:string|number}):Promise<DirectoryHistory> {
  session = await guardEffectiveSession(session, "props.view");
  if(session.kind!=="staff" || session.needsSandbox || ![session.orgId,session.liveOrgId,session.userId,session.sessionId,contactId].every(isUuid) || !["live","sandbox"].includes(session.environment)) return {state:"unavailable"};
  const {page}=parseListQuery(raw);
  let contact: boolean | null = null;
  const payload=await tx(session.userId,async c=>withEffectiveAuthority(c, session, "props.view", async () => {
    const authority = await directorySql(c,session,HISTORY_SQL); contact = authority.contact;
    return (await c.query<HistoryPayload>(authority.sql,[session.orgId,contactId,session.sessionId,session.environment,session.liveOrgId,LIST_PAGE_SIZE+1,(page-1)*LIST_PAGE_SIZE])).rows[0];
  }),{orgId:session.orgId,environment:session.environment});
  if(!payload) return {state:"unavailable"};
  if(!payload.enabled) return {state:"disabled"};
  return {state:"enabled",contact:payload.contact,canViewContact:contact ?? ["admin","manager"].includes(payload.role),page,...slicePage(payload.leases,LIST_PAGE_SIZE,payload.total,page)};
}
