import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  LIST_PAGE_SIZE,
  bindList,
  ilikePattern,
  leaseSearchSql,
  listHref,
  parseListQuery,
  propertySearchSql,
  searchSqlTouchesNationalId,
  slicePage,
  spaceSearchSql,
  tenantContactSearchSql,
  textSearch,
} from "./list-search";

function withoutGatedColumns(sql: string) {
  return sql.replace(/app\.has_role\([\s\S]*?ILIKE \$2 ESCAPE '\\'/g, "");
}

test("search text is trimmed, capped, and ILIKE wildcards stay literal", () => {
  assert.deepEqual(parseListQuery(undefined), { q: "", page: 1 });
  assert.deepEqual(parseListQuery({ q: "  王小美  ", page: "2" }), { q: "王小美", page: 2 });
  assert.deepEqual(parseListQuery({ q: "x", page: "0" }), { q: "x", page: 1 });
  assert.deepEqual(parseListQuery({ q: "x", page: "nope" }), { q: "x", page: 1 });
  assert.equal(parseListQuery({ q: "a".repeat(200) }).q.length, 80);
  assert.equal(ilikePattern(""), null);
  assert.equal(ilikePattern("  "), null);
  assert.equal(ilikePattern("松仁"), "%松仁%");
  assert.equal(ilikePattern("%_\\"), "%\\%\\_\\\\%");
});

test("list SQL is parameterized, org-scoped, paged, and does not read national IDs", () => {
  const idle = bindList("org-1");
  assert.deepEqual(idle.params, ["org-1", null]);
  assert.equal(idle.pageSql, "");
  assert.equal(idle.limit, null);

  const page = bindList("org-1", { q: "延平", page: 2, limit: 1 });
  assert.equal(page.pattern, "%延平%");
  assert.deepEqual(page.params, ["org-1", "%延平%", 2, 1]);
  assert.equal(page.pageSql, "LIMIT $3 OFFSET $4");
  assert.equal(page.limit, 1);
  assert.equal(page.page, 2);

  const full = bindList("org-1", { page: 2, limit: LIST_PAGE_SIZE });
  assert.equal(full.params[2], LIST_PAGE_SIZE + 1);
  assert.equal(full.params[3], LIST_PAGE_SIZE);
  assert.equal(full.pageSql, "LIMIT $3 OFFSET $4");
  const window = slicePage([1, 2, 3], LIST_PAGE_SIZE, 55, 2);
  assert.equal(window.hasNext, false);
  assert.equal(window.from, LIST_PAGE_SIZE + 1);
  assert.equal(window.to, LIST_PAGE_SIZE + 3);
  const first = slicePage(Array.from({ length: LIST_PAGE_SIZE + 1 }, (_, index) => index), LIST_PAGE_SIZE, 55, 1);
  assert.equal(first.rows.length, LIST_PAGE_SIZE);
  assert.equal(first.hasNext, true);
  assert.equal(first.from, 1);
  assert.equal(first.to, LIST_PAGE_SIZE);
  assert.equal(listHref("/m/leases", "王", 2), "/m/leases?q=%E7%8E%8B&page=2");
  assert.equal(listHref("/m/leases", "", 2), "/m/leases?page=2");
  assert.equal(listHref("/m/leases", "王", 1), "/m/leases?q=%E7%8E%8B");

  const capped = bindList("org-1", { limit: 500, page: 1 });
  assert.equal(capped.limit, 100);
  assert.equal(capped.params[2], 101);

  const clauses = [propertySearchSql(), leaseSearchSql(), spaceSearchSql(), tenantContactSearchSql()];
  for (const clause of clauses) {
    assert.match(clause, /\$2::text IS NULL/);
    assert.match(clause, /ILIKE \$2 ESCAPE '\\'/);
    assert.equal(searchSqlTouchesNationalId(clause), false);
    assert.equal(clause.includes("房東"), false);
    assert.equal(clause.includes("房客"), false);
    const open = withoutGatedColumns(clause);
    assert.equal(open.includes("phone_e164"), false);
    assert.equal(open.includes("email"), false);
    assert.equal(open.includes("owner_phone"), false);
    assert.equal(open.includes("owner_email"), false);
  }
  assert.match(leaseSearchSql(), /app\.has_role\(l\.org_id, '\{admin,manager,maintenance\}'\)/);
  assert.match(leaseSearchSql(), /c\.phone_e164/);
  assert.match(leaseSearchSql(), /c\.email::text/);
  assert.match(leaseSearchSql(), /u\.label/);
  assert.match(propertySearchSql(), /p\.address_display/);
  assert.match(propertySearchSql(), /c\.display_name/);
  assert.match(propertySearchSql(), /app\.has_role\(p\.org_id, '\{admin,manager,maintenance\}'\)/);
  assert.match(spaceSearchSql(), /room_label/);
  assert.match(spaceSearchSql(), /app\.has_role\(org_id, '\{admin,manager,maintenance\}'\)/);
  const tenantClause = tenantContactSearchSql();
  assert.match(tenantClause, /c\.display_name/);
  assert.match(tenantClause, /app\.has_role\(c\.org_id, '\{admin,manager,maintenance\}'\)/);
  assert.equal(/join|leases|units|properties/i.test(tenantClause), false);
  assert.equal(textSearch(["p.name"]).includes("$1"), false);

  const queries = readFileSync(new URL("./queries.ts", import.meta.url), "utf8");
  for (const name of ["PROPERTY_LIST_SQL", "LEASE_LIST_SQL", "SPACE_LIST_SQL", "TENANT_LIST_SQL"]) {
    const start = queries.indexOf(`const ${name}`);
    assert.ok(start >= 0, name);
    const body = queries.slice(start, queries.indexOf("async function", start));
    assert.match(body, /org_id = \$1/);
    assert.match(body, /SearchSql\(\)/);
    assert.equal(searchSqlTouchesNationalId(body), false);
  }
  for (const page of ["tenants/page.tsx", "properties/page.tsx", "leases/page.tsx", "units/page.tsx"]) {
    const source = readFileSync(new URL(`../app/m/${page}`, import.meta.url), "utf8");
    assert.match(source, /ListSearch/);
    assert.match(source, /ListPager/);
    assert.match(source, /i_search_range|listSummary/);
    assert.match(source, /search(Tenants|Leases|Properties|Spaces)\(session, raw\)/);
  }
  const header = readFileSync(new URL("../app/layout.tsx", import.meta.url), "utf8");
  assert.equal(header.includes("ListSearch"), false);
  assert.equal(LIST_PAGE_SIZE, 50);
});
