import { FlowError } from "./errors";

/** Deployment admission is an optimization, never permission to drop restrictions. */
export function customRolesAdmitted(orgId: string): boolean {
  try {
    const ids: unknown = JSON.parse(process.env.CUSTOM_ROLES_ORG_ALLOWLIST ?? "null");
    return Array.isArray(ids) && ids.some(id => typeof id === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id) && id === orgId);
  } catch { return false; }
}

/** Piggybacked on the existing live membership query; no extra OFF query. */
export function assertCustomRoleAdmission(orgId: string, enabled: boolean) {
  if (enabled && !customRolesAdmitted(orgId)) {
    console.error("B017 admission mismatch: durable restrictions enabled but deployment admission missing");
    throw new FlowError("errors.forbidden");
  }
}
