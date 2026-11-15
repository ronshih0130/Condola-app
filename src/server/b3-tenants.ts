import { brandV3ReadForOrg } from "./brand-v3";
import { guardEffectiveSession, withEffectiveReadAuthority, customAuthorityAllowsOn } from "./b017-custom-role-governance";
import { tx } from "./db";
import { FlowError, logServerError } from "./errors";
import { requireOrgScope } from "./org-guard";
import { assertPerm } from "./perms";
import { ilikePattern, parseListQuery, textSearch } from "./list-search";
import type { Session } from "./types";

export type TenantsInput = { q?: string; filter?: string; cursor?: string };
export type TenantRow = { id: string; name: string; place: string | null; lineLinked: boolean;
  phone?: string | null; verified?: boolean; staffUpdated?: boolean };
export type TenantsResult = { state: "off" | "unavailable" } | {
  state: "ready"; q: string; filter: "all" | "missing"; canViewPhone: boolean;
  total: number; missing: number | null; filteredCount: number; rows: TenantRow[]; nextCursor: string | null;
};
type Deps = { v3?: (orgId: string) => Promise<boolean>; transaction?: typeof tx };
export const TENANTS_PAGE_SIZE = 50;

// Match the two existing /m/tenants populations: directory ON includes zero-lease
// and co-tenant contacts; OFF retains the legacy primary-lease population.
export const TENANTS_ADMISSION_SQL = `SELECT m.role::text AS role,
 coalesce(o.feature_flags->'tenant_directory_edit'='true'::jsonb
   AND f.value->'enabled'='true'::jsonb AND jsonb_typeof(f.value->'allowed_org_ids')='array'
   AND f.value->'allowed_org_ids' @> jsonb_build_array(o.id::text),false) AS directory
 FROM organizations o
 JOIN org_members m ON m.org_id=CASE WHEN o.environment='sandbox' THEN o.live_org_id ELSE o.id END
 JOIN auth_sessions s ON s.id=$2::uuid AND s.user_id=auth.uid() AND s.user_id=$3::uuid
 LEFT JOIN platform_settings f ON f.key='tenant_directory_edit'
 WHERE o.id=$1::uuid AND o.environment::text=$4
 AND ((o.environment='live' AND o.id=$5::uuid AND o.live_org_id IS NULL)
   OR (o.environment='sandbox' AND o.live_org_id=$5::uuid))
 AND m.user_id=auth.uid() AND m.status='active' AND m.role IN ('admin','manager','accountant')
 AND s.revoked_at IS NULL AND s.expires_at>clock_timestamp()`;

// $1 org, $2 literal search pattern, $3 directory population, $4 phone authority,
// $5 missing filter. Search all eligible units, not just the latest displayed unit.
// Return only the org-scoped LINE link state, never LINE identifiers or account data.
const POPULATION = `WITH population AS MATERIALIZED (
 SELECT c.id, c.display_name AS name, coalesce(c.legal_name,'') AS legal_name,
   CASE WHEN $4::boolean THEN nullif(btrim(c.phone_e164),'') END AS phone,
   history.place, history.places,
   EXISTS (SELECT 1 FROM line_account_links lk WHERE lk.org_id=$1 AND lk.contact_id=c.id
     AND lk.status='linked') AS "lineLinked"
 FROM contacts c
 LEFT JOIN LATERAL (
   SELECT (array_agg(h.place ORDER BY h.created_at DESC,CASE WHEN $3::boolean THEN h.id END DESC,h.id))[1] AS place,
     string_agg(h.place, ' ') AS places, count(*) AS n
   FROM (
     SELECT DISTINCT l.id,l.created_at,p.name || ' ' || u.label || coalesce(' ' || r.label,'') AS place
     FROM lease_parties lp JOIN leases l ON l.id=lp.lease_id AND l.org_id=lp.org_id
     JOIN properties p ON p.id=l.property_id AND p.org_id=l.org_id
     JOIN units u ON u.id=l.unit_id AND u.org_id=l.org_id
     LEFT JOIN rooms r ON r.id=l.target_room_id AND r.org_id=l.org_id
     WHERE lp.org_id=$1 AND lp.contact_id=c.id
       AND (lp.role='primary' OR ($3::boolean AND lp.role='co_tenant'))
   ) h
 ) history ON true
 WHERE c.org_id=$1 AND c.is_tenant AND c.archived_at IS NULL AND ($3::boolean OR history.n>0)
), filtered AS (
 SELECT * FROM population
 WHERE ($2::text IS NULL OR ${textSearch(["name", "legal_name", "coalesce(places,'')"])}
   OR ($4::boolean AND ${textSearch(["coalesce(phone,'')"])}))
 AND (NOT $5::boolean OR ($4::boolean AND nullif(btrim(phone),'') IS NULL))
)`;
export const TENANTS_SUMMARY_SQL = `${POPULATION}
 SELECT (SELECT count(*)::int FROM population) AS total,
   CASE WHEN $4::boolean THEN (SELECT count(*)::int FROM population WHERE nullif(btrim(phone),'') IS NULL) END AS missing,
   (SELECT count(*)::int FROM filtered) AS "filteredCount"`;
export const TENANTS_LIST_SQL = `${POPULATION}
 SELECT id::text,name,place,phone,"lineLinked" FROM filtered
 WHERE ($6::text IS NULL OR (name,id)>($6::text,$7::uuid))
 ORDER BY name,id LIMIT $8`;

type Cursor = { v: 1; org: string; q: string; filter: string; directory: boolean; phone: boolean; name: string; id: string };
function decodeCursor(value: string | undefined, scope: Omit<Cursor,"v" | "name" | "id">): Cursor | null {
  if (value === undefined) return null;
  if (!value || value.length>4096 || !/^[A-Za-z0-9_-]+$/.test(value)) throw new Error("Invalid cursor");
  const c = JSON.parse(Buffer.from(value,"base64url").toString("utf8")) as Cursor;
  if (!c || c.v!==1 || Object.entries(scope).some(([k,v]) => c[k as keyof Cursor]!==v)
    || typeof c.name!=="string" || c.name.length>1000 || typeof c.id!=="string"
    || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(c.id)) throw new Error("Invalid cursor scope");
  return c;
}
export async function brandTenants(session: Session, input: TenantsInput = {}, deps: Deps = {}): Promise<TenantsResult> {
  try {
    if (!(await (deps.v3 ?? brandV3ReadForOrg)(session.orgId))) return { state: "off" };
    const admitted = await guardEffectiveSession(session, "props.view");
    assertPerm(admitted, "props.view");
    if (admitted.needsSandbox) throw new FlowError("errors.forbidden");
    const { q } = parseListQuery(input);
    const filter = input.filter ?? "all";
    if (filter!=="all" && filter!=="missing") throw new Error("Invalid filter");
    return await (deps.transaction ?? tx)(admitted.userId, async client => {
      await client.query("SET LOCAL statement_timeout = '2s'");
      return withEffectiveReadAuthority(client, admitted, "props.view", async () => {
        const context = (await client.query<{ role: string; directory: boolean }>(TENANTS_ADMISSION_SQL,
          [admitted.orgId,admitted.sessionId,admitted.userId,admitted.environment,admitted.liveOrgId])).rows[0];
        if (!context) throw new FlowError("errors.forbidden");
        const canViewPhone = ["admin","manager","maintenance"].includes(context.role)
          && await customAuthorityAllowsOn(client, admitted, "tenants.contact");
        if (filter==="missing" && !canViewPhone) throw new FlowError("errors.forbidden");
        const scope = { org: admitted.orgId,q,filter,directory: context.directory,phone: canViewPhone };
        const cursor = decodeCursor(input.cursor,scope);
        const args = [admitted.orgId,ilikePattern(q),context.directory,canViewPhone,filter==="missing"];
        const summary = (await client.query<{ total: number; missing: number | null; filteredCount: number }>(TENANTS_SUMMARY_SQL,args)).rows[0];
        if (!summary) throw new Error("Missing tenant counts");
        const page = (await client.query<TenantRow>(TENANTS_LIST_SQL,
          [...args,cursor?.name ?? null,cursor?.id ?? null,TENANTS_PAGE_SIZE+1])).rows;
        const rows = page.slice(0,TENANTS_PAGE_SIZE).map(({ phone, ...row }): TenantRow => canViewPhone
          // This checkout has no B-048 phone_source / phone_verified_at schema.
          // Approved B-048 spec §2 treats existing numbers as staff, unconfirmed.
          ? { ...row,phone,verified:false,staffUpdated:!!phone } : row);
        const last = rows.at(-1);
        return { state:"ready" as const,q,filter,canViewPhone,...summary,missing:canViewPhone ? summary.missing : null,rows,
          nextCursor:page.length>TENANTS_PAGE_SIZE && last
            ? Buffer.from(JSON.stringify({ v:1,...scope,name:last.name,id:last.id })).toString("base64url") : null };
      });
    },requireOrgScope(admitted),{ isolation:"repeatable read",readOnly:true });
  } catch (error) {
    if (error instanceof FlowError && error.key==="errors.forbidden") throw error;
    logServerError("b3_tenants",error);
    return { state:"unavailable" };
  }
}
