/** Org-scoped list search. Patterns are bound parameters; ILIKE wildcards in the query are escaped. */

export const LIST_PAGE_SIZE = 50;

const MAX_PAGE = 10_000;
const MAX_QUERY = 80;
const MAX_LIMIT = 100;

export type ListOpts = {
  q?: string;
  page?: number;
  /** When omitted, the query is not paged. List pages always pass a limit. */
  limit?: number;
};

export function parseListQuery(raw?: { q?: string; page?: string | number }) {
  const q = String(raw?.q ?? "").trim().slice(0, MAX_QUERY);
  const parsed = typeof raw?.page === "number" ? raw.page : Number(raw?.page);
  const page = Number.isInteger(parsed) && parsed > 0 ? Math.min(parsed, MAX_PAGE) : 1;
  return { q, page };
}

/** `%` and `_` in the typed query stay literal. The value is bound, never concatenated. */
export function ilikePattern(q: string): string | null {
  const trimmed = q.trim().slice(0, MAX_QUERY);
  if (!trimmed) return null;
  return `%${trimmed.replace(/[\\%_]/g, (char) => `\\${char}`)}%`;
}

export function bindList(orgId: string, opts?: ListOpts) {
  const pattern = ilikePattern(opts?.q ?? "");
  const params: unknown[] = [orgId, pattern];
  const limit = opts?.limit && opts.limit > 0 ? Math.min(Math.floor(opts.limit), MAX_LIMIT) : null;
  let pageSql = "";
  if (limit !== null) {
    const page = opts?.page && opts.page > 0 ? Math.min(Math.floor(opts.page), MAX_PAGE) : 1;
    params.push(limit + 1, (page - 1) * limit);
    pageSql = `LIMIT $${params.length - 1} OFFSET $${params.length}`;
  }
  return { params, pageSql, limit, pattern };
}

/** Column expressions are fixed in code. `param` is a placeholder such as `$2`. */
export function textSearch(columns: readonly string[], param = "$2") {
  return columns.map((column) => `${column} ILIKE ${param} ESCAPE '\\'`).join(" OR ");
}

/**
 * Phone and email match only for roles that already receive tenant contact details.
 * National ID numbers are not a column here.
 */
export function gatedColumn(expr: string, orgExpr: string, param = "$2") {
  return `(app.has_role(${orgExpr}, '{admin,manager,maintenance}') AND coalesce(${expr}, '') ILIKE ${param} ESCAPE '\\')`;
}

/** Name stays open. Email and phone use the tenant-contact role check. Alias is `c`. */
export function contactMatch(orgExpr = "c.org_id") {
  return [
    textSearch(["c.display_name", "coalesce(c.legal_name, '')"]),
    gatedColumn("c.email::text", orgExpr),
    gatedColumn("c.phone_e164", orgExpr),
  ].join(" OR ");
}

/**
 * Predicate for a `contacts c` row. A one-row-per-tenant query can append this
 * after `WHERE c.org_id = $1 AND c.is_tenant AND c.archived_at IS NULL`.
 */
export function tenantContactSearchSql() {
  return orSearch([contactMatch("c.org_id")]);
}

export function orSearch(parts: readonly string[]) {
  return `AND ($2::text IS NULL OR ${parts.join(" OR ")})`;
}

export const PROPERTY_TEXT = ["p.name", "coalesce(p.address_display, '')", "coalesce(p.address::text, '')"] as const;

export const OWNER_NAME = ["c.display_name", "coalesce(c.legal_name, '')"] as const;

export const LEASE_PLACE = ["u.label", "coalesce(r.label, '')", "p.name", "coalesce(p.address_display, '')"] as const;

export const SPACE_TEXT = [
  "property_name",
  "coalesce(address_display, '')",
  "coalesce(address_text, '')",
  "floor",
  "coalesce(room_label, '')",
  "coalesce(owner_name, '')",
] as const;

const ID_COLUMNS = ["identity_documents", "number_masked", "number_hash", "doc_type"];

export function propertySearchSql() {
  return orSearch([
    textSearch(PROPERTY_TEXT),
    `EXISTS (
       SELECT 1 FROM property_owners po
       JOIN contacts c ON c.id = po.owner_contact_id
      WHERE po.property_id = p.id
        AND (${textSearch(OWNER_NAME)} OR ${gatedColumn("c.email::text", "p.org_id")} OR ${gatedColumn("c.phone_e164", "p.org_id")})
     )`,
  ]);
}

export function leaseSearchSql() {
  return orSearch([textSearch(LEASE_PLACE), contactMatch("l.org_id")]);
}

export function spaceSearchSql() {
  return orSearch([textSearch(SPACE_TEXT), gatedColumn("owner_phone", "org_id"), gatedColumn("owner_email", "org_id")]);
}

export function searchSqlTouchesNationalId(sql: string) {
  const lowered = sql.toLowerCase();
  return ID_COLUMNS.some((column) => lowered.includes(column));
}

export function pageRows<T>(rows: T[], limit: number | null) {
  if (limit === null || rows.length <= limit) return { rows, hasNext: false };
  return { rows: rows.slice(0, limit), hasNext: true };
}
