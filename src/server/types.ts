import type { Locale } from "@/i18n";
import { FlowError } from "./errors";

export type OrgRole = "admin" | "manager" | "accountant" | "maintenance";
export type CalendarMode = "gregorian" | "roc";

export type Session = {
  userId: string;
  consent?: import("./consent").StoredConsent | null;
  sessionId: string;
  email: string;
  name: string;
  kind: "staff" | "tenant" | "owner";
  role: OrgRole | null;
  orgId: string;
  /** Live firm when this session is inside its sandbox. */
  liveOrgId: string;
  environment: "live" | "sandbox";
  /** Live mode is unlocked for this firm. Absent on portal sessions. */
  liveEnabled?: boolean;
  needsSandbox?: boolean;
  locale: Locale;
  calendar: CalendarMode;
  leaseId: string | null;
  /** Set when this login is linked to a tenant contact, an owner contact, or both. */
  portals?: { owner: boolean; tenant: boolean };
};

export function assertStaff(session: Session, roles: OrgRole[]) {
  if (session.kind !== "staff" || !session.role || !roles.includes(session.role)) {
    throw new FlowError("errors.forbidden");
  }
}
