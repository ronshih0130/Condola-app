import type { Locale } from "@/i18n";
import { FlowError } from "./errors";

export type OrgRole = "admin" | "manager" | "accountant" | "maintenance";
export type CalendarMode = "gregorian" | "roc";

export type Session = {
  userId: string;
  sessionId: string;
  email: string;
  name: string;
  kind: "staff" | "tenant" | "owner";
  role: OrgRole | null;
  orgId: string;
  locale: Locale;
  calendar: CalendarMode;
  leaseId: string | null;
};

export function assertStaff(session: Session, roles: OrgRole[]) {
  if (session.kind !== "staff" || !session.role || !roles.includes(session.role)) {
    throw new FlowError("errors.forbidden");
  }
}
