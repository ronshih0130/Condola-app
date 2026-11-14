import assert from "node:assert/strict";
import test from "node:test";
import { can, ROLE_KEYS } from "@/server/perms";
import { EMPTY_ACTIONS as A, EMPTY_PAGES, emptyPageAction, resolveEmptyCta, type EmptyAction, type EmptyPage, type EmptySetup } from "./empty-cta";

// Port of approved mockup app.js resolve(s,p). Independent role/action table;
// §3.2 explicitly allows range changes for anyone admitted to the reports page.
const roleActions = {
  admin: null,
  manager: ["unit", "import", "manual", "invite", "lease", "rent", "utility", "expense", "range", "ticket", "owner", "today", "clear", "importLink"],
  accountant: ["rent", "bank", "expense", "range", "today", "clear"],
  maintenance: ["ticket", "range", "clear"],
};
const ownIds: Record<EmptyPage, keyof typeof A | null> = { DASH: null, MSG: null, PROP: "unit", UNIT: "unit", TEN: "invite", TENID: "lease", LEASE: "lease", PAY: "rent", BANK: "bank", UTIL: "utility", EXP: "expense", STMT: "rent", RPT: "range", TIX: "ticket", OWN: "owner", NOTI: "today", SRCH: "clear" };
function oracle(page: EmptyPage, p: number, role: typeof ROLE_KEYS[number], flag: boolean, mode: EmptySetup["inviteMode"], hasUnits: boolean) {
  const allowed = (a: string | null): a is keyof typeof A => !!a && (a === "sample" || roleActions[role] === null || roleActions[role]!.includes(a));
  const remap = (a: keyof typeof A | null) => a === "invite" && mode === "no_lease" ? "lease" : a;
  if (page === "SRCH") return { primary: "clear", links: [], hint: false };
  const own = remap(ownIds[page]);
  const fixed = page === "DASH" && !hasUnits ? "import" : page === "MSG" ? "invite" : null;
  const next = ["company", "unit", "invite", "invite"] as const;
  const target = remap(fixed ?? (flag && p < 4 ? next[p] : own));
  let primary: keyof typeof A | null = null;
  const links: string[] = [];
  if (allowed(target)) { primary = target; if (own && own !== target && allowed(own)) links.push(own); }
  else if (own && own !== target && allowed(own)) primary = own;
  const hint = primary === null && p < 4;
  if (page === "DASH") {
    if (!hasUnits) { if (allowed("manual")) links.push("manual"); links.push("sample"); }
    else if (!flag || p < 2 || p === 4) primary = null;
  }
  if ((page === "PROP" || page === "UNIT") && allowed("importLink")) links.push("importLink");
  return { primary, links: links.filter(a => a !== primary).slice(0, 2), hint };
}

for (const page of EMPTY_PAGES) for (const step of [0, 1, 2, 3, 4] as const) for (const role of ROLE_KEYS) for (const flag of [false, true]) {
  test(`MGT-55-AC1/AC2/AC3/AC6 MGT-56-AC1–AC10 oracle: ${page} step=${step} ${role} flag=${flag}`, () => {
    for (const inviteMode of ["m4", "lease", "no_lease"] as const) for (const hasUnits of [false, true]) {
      const setup: EmptySetup = { step, checklistOn: flag, hasUnits, inviteMode, inviteHref: inviteMode === "m4" ? "/m/units/unit/invite" : "/m/leases/lease" };
      const result = resolveEmptyCta({ page, setup, can: key => can(role, key) });
      const expected = oracle(page, step, role, flag, inviteMode, hasUnits);
      assert.equal(result.primary?.key ?? null, expected.primary ? A[expected.primary as keyof typeof A].key : null);
      assert.deepEqual(result.links.map(a => a.key), expected.links.map(id => A[id as keyof typeof A].key));
      assert.equal(result.showAdminHint, expected.hint);
      assert.ok(!Array.isArray(result.primary)); assert.ok(result.links.length <= 2);
      assert.ok(!result.links.some(a => a.key === result.primary?.key));
      if (result.primary?.key === A.invite.key) assert.equal(result.primary.href, setup.inviteHref);
      if (result.primary?.perm) assert.ok(can(role, result.primary.perm));
    }
  });
}
test("MGT-56-AC4: search clears the actual page URL irrespective of role or setup", () => {
  for (const path of ["properties", "units", "tenants", "leases", "audit"]) {
    const result = resolveEmptyCta({ page: "SRCH", setup: { step: 0, checklistOn: true, hasUnits: false, inviteMode: "no_lease", inviteHref: "" }, can: () => false, pageAction: { ...A.clear, href: `/m/${path}` } });
    assert.equal(result.primary?.href, `/m/${path}`); assert.equal(result.showAdminHint, false);
  }
});
test("MGT-56-AC6/AC7/AC10: custom permissions govern fallback after no-lease substitution", () => {
  const setup: EmptySetup = { step: 2, checklistOn: true, hasUnits: true, inviteMode: "no_lease", inviteHref: "" };
  const result = resolveEmptyCta({ page: "EXP", setup, can: key => key === "exp.add" });
  assert.equal(result.primary?.key, A.expense.key);
  assert.equal(resolveEmptyCta({ page: "TEN", setup, can: key => key === "props.edit" }).primary, null);
  assert.equal(emptyPageAction("DASH"), null);
  const action: EmptyAction = { ...A.lease, href: "/m/leases/new?tenant=example" };
  assert.equal(resolveEmptyCta({ page: "TENID", setup: { ...setup, step: 4 }, can: () => true, pageAction: action }).primary?.href, action.href);
});

test("B-046 r3: the invite CTA uses the B-040 invite permission (leases.edit), not props.edit", () => {
  const setup: EmptySetup = { step: 2, checklistOn: true, hasUnits: true, inviteMode: "m4", inviteHref: "/m/units/u1/invite" };
  for (const page of ["TEN", "MSG"] as const) {
    assert.equal(resolveEmptyCta({ page, setup, can: key => key === "props.edit" || key === "props.view" || key === "dash.view" }).primary, null, page);
    assert.equal(resolveEmptyCta({ page, setup, can: key => key === "leases.edit" }).primary?.href, "/m/units/u1/invite", page);
  }
  assert.equal(resolveEmptyCta({ page: "UNIT", setup, can: key => key === "props.edit" }).primary?.key, A.unit.key);
});
