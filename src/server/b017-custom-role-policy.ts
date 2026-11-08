/**
 * Pure B-017 policy model. No cookie, DB or flag reader.
 * Inputs model trusted, freshly resolved authority; they are NOT credentials.
 * The trusted governance adapter reuses gate/key validation; the modeled
 * permission evaluator intersects grants with the target native ceiling.
 */
import { can, PERMS, ROLE_KEYS, type PermKey } from "./perms";
import type { OrgRole } from "./types";

export const B017_CAPABILITY_VERSION = 1;
export const B017_SUPPORTED_KEYS = Object.freeze([
  "dash.view", "props.view", "props.edit", "leases.edit", "tenants.contact",
  "pay.record", "pay.reverse", "bank.reconcile", "stmt.view", "stmt.generate",
  "exp.add", "month.close", "tickets.update", "messages.send", "reports.export",
  "team.manage", "settings.edit",
] as const satisfies readonly PermKey[]);
export type B017SupportedKey = (typeof B017_SUPPORTED_KEYS)[number];
export type B017Decision = "allow" | "deny" | "unavailable";

export function validateB017Keys(input: unknown):
  | { ok: true; keys: readonly B017SupportedKey[] }
  | { ok: false; reason: "invalid-array" | "unsupported-key" | "duplicate-key" } {
  if (!Array.isArray(input)) return { ok: false, reason: "invalid-array" };
  const keys: B017SupportedKey[] = [];
  for (const key of input) {
    if (typeof key !== "string" || !B017_SUPPORTED_KEYS.includes(key as B017SupportedKey)) {
      return { ok: false, reason: "unsupported-key" };
    }
    if (keys.includes(key as B017SupportedKey)) return { ok: false, reason: "duplicate-key" };
    keys.push(key as B017SupportedKey);
  }
  return { ok: true, keys: Object.freeze(keys) };
}

export type B017Subject = {
  orgId: string;
  nativeRole: OrgRole | null;
  authority:
    | { state: "native" }
    | {
        state: "enforced";
        capabilityVersion: unknown;
        // Missing assignment is unknown authority, distinct from an explicit unassigned tombstone.
        assignment: { roleId: string | null } | null;
        role: {
          id: string;
          orgId: string;
          lifecycle: "draft" | "active" | "retired";
          capabilityVersion: unknown;
          keys: unknown;
        } | null;
      };
};

type EffectivePolicy = { status: "available"; keys: readonly PermKey[] } | { status: "unavailable" };

export function resolveB017Policy(subject: B017Subject): EffectivePolicy {
  const { nativeRole, authority } = subject;
  if (!subject.orgId || !nativeRole || !ROLE_KEYS.includes(nativeRole)) return { status: "unavailable" };
  const nativeKeys = () => PERMS.filter(([key]) => can(nativeRole, key)).map(([key]) => key);
  if (authority.state === "native") return { status: "available", keys: nativeKeys() };
  if (authority.state !== "enforced" || authority.capabilityVersion !== B017_CAPABILITY_VERSION || !authority.assignment) {
    return { status: "unavailable" };
  }
  if (authority.assignment.roleId === null) {
    // Explicit unassigned state only. data.export has no supported v1 operation.
    return { status: "available", keys: nativeKeys().filter((key) => key !== "data.export") };
  }
  const role = authority.role;
  if (!role || !role.id || role.id !== authority.assignment.roleId || role.orgId !== subject.orgId ||
      role.lifecycle !== "active" || role.capabilityVersion !== B017_CAPABILITY_VERSION) {
    return { status: "unavailable" };
  }
  const validated = validateB017Keys(role.keys);
  return validated.ok ? { status: "available", keys: validated.keys.filter(key => can(nativeRole, key)) } : { status: "unavailable" };
}

export function evaluateB017Permission(subject: B017Subject, key: string): B017Decision {
  const policy = resolveB017Policy(subject);
  if (policy.status === "unavailable") return "unavailable";
  return policy.keys.includes(key as PermKey) ? "allow" : "deny";
}

/** Photos are a separate capability: granting ticket text never removes the native floor. */
export function evaluateB017Photo(subject: B017Subject): B017Decision {
  const text = evaluateB017Permission(subject, "tickets.update");
  if (text !== "allow") return text;
  return subject.nativeRole === "accountant" ? "deny" : "allow";
}

export function evaluateB017CompanyAudit(subject: B017Subject): B017Decision {
  if (resolveB017Policy(subject).status === "unavailable") return "unavailable";
  return subject.nativeRole === "admin" ? "allow" : "deny";
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : null;
}

export type B017ManagementGate = { platformSettings: unknown; organizationFlags: unknown };

/** Missing/malformed gates are OFF. This gate never selects permission semantics. */
export function b017ManagementEnabled(orgId: string, gate: B017ManagementGate): boolean {
  const config = record(record(gate.platformSettings)?.custom_roles);
  const orgFlags = record(gate.organizationFlags);
  const allowlist = config?.allowed_org_ids;
  return config?.enabled === true && orgFlags?.custom_roles === true &&
    Array.isArray(allowlist) && [...allowlist].every((id) => typeof id === "string" && id.length > 0) &&
    orgId.length > 0 && allowlist.includes(orgId);
}

export function evaluateB017Governance(subject: B017Subject, gate: B017ManagementGate): B017Decision {
  const team = evaluateB017Permission(subject, "team.manage");
  if (team !== "allow") return team;
  return subject.nativeRole === "admin" && b017ManagementEnabled(subject.orgId, gate) ? "allow" : "deny";
}

/** Grant ceiling only; NOT an assignment command or proof of last-admin/self/replay safety. */
export function evaluateB017Grant(actor: B017Subject, requested: unknown, gate: B017ManagementGate): B017Decision {
  const validated = validateB017Keys(requested);
  if (!validated.ok) return "deny";
  const governance = evaluateB017Governance(actor, gate);
  if (governance !== "allow") return governance;
  return validated.keys.every((key) => evaluateB017Permission(actor, key) === "allow") ? "allow" : "deny";
}
