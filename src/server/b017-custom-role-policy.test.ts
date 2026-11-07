import assert from "node:assert/strict";
import test from "node:test";
import { PERMS, ROLE_KEYS, can } from "./perms";
import {
  B017_SUPPORTED_KEYS, b017ManagementEnabled, evaluateB017CompanyAudit,
  evaluateB017Governance, evaluateB017Grant, evaluateB017Permission,
  evaluateB017Photo, resolveB017Policy, validateB017Keys,
  type B017ManagementGate, type B017Subject,
} from "./b017-custom-role-policy";
import type { OrgRole } from "./types";

const ON: B017ManagementGate = {
  platformSettings: { custom_roles: { enabled: true, allowed_org_ids: ["org-a"] } },
  organizationFlags: { custom_roles: true },
};
const OFF: B017ManagementGate = {
  ...ON, platformSettings: { custom_roles: { enabled: false, allowed_org_ids: ["org-a"] } },
};
const native = (nativeRole: OrgRole | null): B017Subject => ({ orgId: "org-a", nativeRole, authority: { state: "native" } });
function assigned(nativeRole: OrgRole, keys: unknown): B017Subject & { authority: Extract<B017Subject["authority"], { state: "enforced" }> } {
  return {
    orgId: "org-a", nativeRole,
    authority: {
      state: "enforced", capabilityVersion: 1, assignment: { roleId: "role-a" },
      role: { id: "role-a", orgId: "org-a", lifecycle: "active", capabilityVersion: 1, keys },
    },
  };
}

test("v1 supports exactly the recognized 18 minus data.export", () => {
  assert.equal(B017_SUPPORTED_KEYS.length, 17);
  assert.deepEqual([...B017_SUPPORTED_KEYS], PERMS.map(([key]) => key).filter((key) => key !== "data.export"));
  assert.deepEqual(validateB017Keys([]), { ok: true, keys: [] });
  assert.deepEqual(validateB017Keys([...B017_SUPPORTED_KEYS]), { ok: true, keys: B017_SUPPORTED_KEYS });
});

for (const key of B017_SUPPORTED_KEYS) {
  test(`accept and grant supported key ${key} within each target native ceiling`, () => {
    assert.deepEqual(validateB017Keys([key]), { ok: true, keys: [key] });
    assert.equal(evaluateB017Grant(native("admin"), [key], ON), "allow");
    for (const role of ROLE_KEYS) {
      const subject = assigned(role, [key]);
      for (const [candidate] of PERMS) {
        assert.equal(evaluateB017Permission(subject, candidate), candidate === key && can(role, key) ? "allow" : "deny", `${role}:${candidate}`);
      }
    }
    assert.deepEqual(validateB017Keys([key, key]), { ok: false, reason: "duplicate-key" });
    assert.equal(evaluateB017Grant(native("admin"), [key, key], ON), "deny");
  });
}

test("unknown, unsupported, duplicate and malformed grants reject the entire input", () => {
  for (const keys of [
    ["data.export"], ["dash.view", "data.export"], ["unknown"], ["dash.view", "unknown"],
    ["team.manage", "team.manage"], ["Team.Manage"], [" team.manage"], [null], [true],
    new Array(1), null, undefined, "team.manage", {},
  ]) {
    assert.equal(validateB017Keys(keys).ok, false, JSON.stringify(keys));
    assert.equal(evaluateB017Grant(native("admin"), keys, ON), "deny");
    assert.deepEqual(resolveB017Policy(assigned("admin", keys)), { status: "unavailable" });
  }
  assert.equal(evaluateB017Permission(assigned("admin", []), "unknown"), "deny");
});

test("validation copies its input; later caller mutation cannot change the validated grants", () => {
  const input = ["bank.reconcile"];
  const validated = validateB017Keys(input);
  input.push("data.export");
  assert.deepEqual(validated, { ok: true, keys: ["bank.reconcile"] });
  if (validated.ok) assert.equal(Object.isFrozen(validated.keys), true);
});

test("Admin grant ceiling and target native ceiling both apply", () => {
  assert.equal(can("manager", "bank.reconcile"), false);
  assert.equal(evaluateB017Grant(native("admin"), ["bank.reconcile"], ON), "allow");
  assert.equal(evaluateB017Permission(assigned("manager", ["bank.reconcile"]), "bank.reconcile"), "deny");
  const restrictedAdmin = assigned("admin", ["team.manage"]);
  assert.equal(evaluateB017Governance(restrictedAdmin, ON), "allow");
  assert.equal(evaluateB017Grant(restrictedAdmin, ["bank.reconcile"], ON), "deny");
  assert.equal(evaluateB017Grant(restrictedAdmin, ["team.manage"], ON), "allow");
  assert.equal(evaluateB017Governance(assigned("admin", ["settings.edit"]), ON), "deny");
});

test("Accountant tickets.update cannot grant text or photo; native identity still controls audit/governance", () => {
  for (const role of ROLE_KEYS) {
    const subject = assigned(role, ["tickets.update", "team.manage", "settings.edit"]);
    assert.equal(evaluateB017Permission(subject, "tickets.update"), can(role, "tickets.update") ? "allow" : "deny");
    assert.equal(evaluateB017Permission(subject, "team.manage"), can(role, "team.manage") ? "allow" : "deny");
    assert.equal(evaluateB017Permission(subject, "settings.edit"), can(role, "settings.edit") ? "allow" : "deny");
    assert.equal(evaluateB017Photo(subject), role === "accountant" ? "deny" : "allow");
    assert.equal(evaluateB017CompanyAudit(subject), role === "admin" ? "allow" : "deny");
    assert.equal(evaluateB017Governance(subject, ON), role === "admin" ? "allow" : "deny");
    assert.equal(evaluateB017Grant(subject, ["team.manage"], ON), role === "admin" ? "allow" : "deny");
    assert.equal(evaluateB017Photo(assigned(role, [])), "deny");
  }
});

test("poisoned, missing, retired, draft, foreign and version-mismatched authority is unavailable, even with management OFF", () => {
  const mutations: Array<(subject: ReturnType<typeof assigned>) => void> = [
    (s) => { s.authority.role = null; },
    (s) => { s.authority.assignment = null; },
    (s) => { s.authority.role!.lifecycle = "retired"; },
    (s) => { s.authority.role!.lifecycle = "draft"; },
    (s) => { s.authority.role!.id = "other-role"; },
    (s) => { s.authority.role!.orgId = "other-org"; },
    (s) => { s.authority.role!.keys = ["data.export"]; },
    (s) => { s.authority.role!.keys = ["team.manage", "team.manage"]; },
    ...[0, 2, "1", true, null, undefined].flatMap((version) => [
      (s: ReturnType<typeof assigned>) => { s.authority.capabilityVersion = version; },
      (s: ReturnType<typeof assigned>) => { s.authority.role!.capabilityVersion = version; },
    ]),
  ];
  for (const mutate of mutations) {
    const subject = assigned("admin", B017_SUPPORTED_KEYS);
    mutate(subject);
    assert.deepEqual(resolveB017Policy(subject), { status: "unavailable" });
    for (const [key] of PERMS) assert.equal(evaluateB017Permission(subject, key), "unavailable");
    assert.equal(evaluateB017Photo(subject), "unavailable");
    assert.equal(evaluateB017CompanyAudit(subject), "unavailable");
    for (const gate of [ON, OFF]) {
      assert.equal(evaluateB017Governance(subject, gate), "unavailable");
      assert.equal(evaluateB017Grant(subject, ["bank.reconcile"], gate), "unavailable");
    }
  }
});

test("only explicit unassigned enforced state uses native supported rights; native mode preserves all 18", () => {
  for (const role of ROLE_KEYS) {
    const subject = assigned(role, []);
    subject.authority.assignment = { roleId: null };
    subject.authority.role = null;
    for (const [key] of PERMS) {
      assert.equal(evaluateB017Permission(native(role), key), can(role, key) ? "allow" : "deny");
      assert.equal(evaluateB017Permission(subject, key), key !== "data.export" && can(role, key) ? "allow" : "deny");
    }
  }
  assert.equal(evaluateB017CompanyAudit(native(null)), "unavailable");
  assert.equal(evaluateB017Permission(native(null), "dash.view"), "unavailable");
});

test("management requires literal true at both gates and an exact well-formed org allowlist", () => {
  assert.equal(b017ManagementEnabled("org-a", ON), true);
  assert.equal(b017ManagementEnabled("org-b", ON), false);
  for (const malformed of [false, "true", "false", 1, 0, null, undefined, {}, []]) {
    assert.equal(b017ManagementEnabled("org-a", {
      ...ON, platformSettings: { custom_roles: { enabled: malformed, allowed_org_ids: ["org-a"] } },
    }), false);
    assert.equal(b017ManagementEnabled("org-a", { ...ON, organizationFlags: { custom_roles: malformed } }), false);
    assert.equal(b017ManagementEnabled("org-a", { ...ON, platformSettings: malformed }), false);
    assert.equal(b017ManagementEnabled("org-a", { ...ON, organizationFlags: malformed }), false);
    assert.equal(b017ManagementEnabled("org-a", { ...ON, platformSettings: { custom_roles: malformed } }), false);
  }
  for (const allowed_org_ids of [null, undefined, "org-a", [], ["org-b"], ["org-a", 1], ["org-a", ""], ["org-a", ,]]) {
    assert.equal(b017ManagementEnabled("org-a", {
      ...ON, platformSettings: { custom_roles: { enabled: true, allowed_org_ids } },
    }), false);
  }
});

test("management OFF preserves existing assignment restrictions and native ceilings but denies governance", () => {
  const actor = assigned("admin", ["team.manage", "bank.reconcile"]);
  assert.equal(evaluateB017Governance(actor, ON), "allow");
  for (const gate of [OFF, { ...ON, organizationFlags: { custom_roles: false } }, { platformSettings: null, organizationFlags: null }]) {
    assert.equal(evaluateB017Governance(actor, gate), "deny");
    assert.equal(evaluateB017Grant(actor, ["bank.reconcile"], gate), "deny");
    assert.equal(evaluateB017Permission(actor, "bank.reconcile"), "allow");
    assert.equal(evaluateB017Permission(actor, "settings.edit"), "deny");
    assert.equal(evaluateB017Permission(actor, "data.export"), "deny");
    assert.equal(evaluateB017Permission(assigned("manager", ["bank.reconcile"]), "bank.reconcile"), "deny");
    assert.equal(evaluateB017Photo(assigned("accountant", ["tickets.update"])), "deny");
  }
  for (const [key] of PERMS) assert.equal(evaluateB017Permission(assigned("admin", []), key), "deny");
});
