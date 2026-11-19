import { logServerError } from "./errors";
import { homeRepairStep } from "./b090-tenant-home-rules";
import { loadLeaseIdCheck } from "./id-docs";
import { identityRequiredForSigningFor } from "./id-sign-gate";
import { tenantLeaseMoney, tenantRepairs, tenantSignedLeasePdfs, ticketDetail } from "./queries";
import { isUuid } from "./repair-rules";
import { ticketPhotoRecovery } from "./upload-recovery";
import type { Session } from "./types";

/**
 * Brand 3.0 B-090 slice 3 (re-land, PENDING-RON PR-043): the read parts of RT-REPAIR (TEN-56-AC4/AC5) and RT-LEASE
 * (TEN-57-AC1). v3-only: called only from the brand_v3 ON branch of /t/repair and /t/lease. It composes the readers
 * those pages already call (tenantRepairs, ticketDetail, ticketPhotoRecovery, tenantLeaseMoney, loadLeaseIdCheck,
 * tenantSignedLeasePdfs, identityRequiredForSigningFor) under the tenant's own RLS, unchanged and with the same
 * arguments. It adds no query, no write and no database object. The vendor time question, the visit choice and entry
 * authorisation (B-088) and the renewal question (B-089) have no data yet and are not modelled here.
 */

// ---------- RT-REPAIR ----------

/** Where a repair stands, from the ticket status only. The three open stages are RT-HOME's card steps. */
export type RepairStage = "reported" | "dispatched" | "working" | "done" | "cancelled";
export function repairStage(status: string): RepairStage | null {
  const open = homeRepairStep(status); // open/triaged → reported, assigned → dispatched, in_progress/on_hold → working
  if (open) return open;
  if (status === "resolved" || status === "closed") return "done";
  if (status === "cancelled") return "cancelled";
  return null; // an unknown status is never guessed
}

/** TEN-56-AC4 steps. 約好時間 is left out: there is no tenant-provable agreed time until B-088. */
export const REPAIR_STEPS = ["reported", "dispatched", "working", "done"] as const;
export type RepairStepId = (typeof REPAIR_STEPS)[number];
export type RepairStep = { id: RepairStepId; state: "done" | "now" | "todo"; current: boolean; date: string | null };

/**
 * Steps before the current stage are done, the current one is "now" (已完成 is done and current). TEN-56-AC5: 已完成
 * carries the completion date when the ticket has a well-formed one. A cancelled repair has no steps.
 */
export function repairSteps(stage: RepairStage, completedOn: string | null): RepairStep[] {
  if (stage === "cancelled") return [];
  const at = REPAIR_STEPS.indexOf(stage);
  const date = stage === "done" && completedOn && /^\d{4}-\d{2}-\d{2}$/.test(completedOn) ? completedOn : null;
  return REPAIR_STEPS.map((id, i) => ({
    id,
    state: i < at || (i === at && id === "done") ? "done" : i === at ? "now" : "todo",
    current: i === at,
    date: id === "done" ? date : null,
  }));
}

export type TenantRepairRow = { id: string; number: string; title: string; category: string; stage: RepairStage | null };
type Detail = NonNullable<Awaited<ReturnType<typeof ticketDetail>>>;
export type TenantRepairProgress = {
  id: string; number: string; title: string; description: string | null; category: string; status: string;
  stage: RepairStage; steps: RepairStep[];
};
export type TenantRepairView =
  | { state: "error" }
  | { state: "list"; repairs: TenantRepairRow[] }
  | { state: "progress"; repair: TenantRepairProgress; comments: Detail["comments"]; photos: Detail["photos"];
      uploadRecovery: Awaited<ReturnType<typeof ticketPhotoRecovery>> };

export type RepairDeps = { repairs?: typeof tenantRepairs; detail?: typeof ticketDetail; recovery?: typeof ticketPhotoRecovery };

/**
 * `/t/repair` (list) and `/t/repair?id=` (progress). A repair opens only when it is in the tenant's own selected
 * lease's list (the existing page's ownership check, run before the detail is read); anything else shows the list.
 * Costs, the vendor and internal lines are never copied into the view (TEN-56-AC4).
 */
export async function tenantRepairView(session: Session, leaseId: string, selectedId: string | undefined, deps: RepairDeps = {}): Promise<TenantRepairView> {
  const readRepairs = deps.repairs ?? tenantRepairs, readDetail = deps.detail ?? ticketDetail, readRecovery = deps.recovery ?? ticketPhotoRecovery;
  try {
    const rows = await readRepairs(session, leaseId);
    const id = typeof selectedId === "string" && isUuid(selectedId) && rows.some(r => r.id === selectedId) ? selectedId : "";
    const detail = id ? await readDetail(session, id) : null;
    const own = detail && detail.ticket.id === id ? detail : null;
    if (own) {
      const t = own.ticket;
      const stage = repairStage(t.status);
      if (!stage) return { state: "error" };
      return {
        state: "progress",
        repair: { id: t.id, number: t.number, title: t.title, description: t.description, category: t.category, status: t.status, stage,
          steps: repairSteps(stage, t.completed_on) },
        comments: own.comments.filter(c => !c.internal),
        photos: own.photos.filter(p => !p.internal),
        uploadRecovery: await readRecovery(session, t.id),
      };
    }
    return { state: "list", repairs: rows.map(r => ({ id: r.id, number: r.number, title: r.title, category: r.category, stage: repairStage(r.status) })) };
  } catch (error) {
    logServerError("b090_tenant_repair", error);
    return { state: "error" };
  }
}

// ---------- RT-LEASE ----------

type LeaseMoney = NonNullable<Awaited<ReturnType<typeof tenantLeaseMoney>>>;
type TermsInput = { currency: string; lease: Pick<LeaseMoney["lease"], "place" | "start_date" | "end_date" | "rent" | "deposit"> & { due_day: number | null } };
export type TenantLeaseTerms = {
  place: string; start: string; end: string; rentMinor: number; depositMinor: number; currency: string; dueDay: number | null;
};

/**
 * TEN-57-AC1 terms, read-only, from the existing tenant lease reader (tenantLeaseMoney): 物件／租期／租金／繳租日／押金.
 * A due day outside 1–31 is left out rather than shown wrong.
 */
export function tenantLeaseTerms(money: TermsInput): TenantLeaseTerms {
  const day = money.lease.due_day;
  const dueDay = typeof day === "number" && Number.isInteger(day) && day >= 1 && day <= 31 ? day : null;
  return {
    place: money.lease.place, start: money.lease.start_date, end: money.lease.end_date,
    rentMinor: Number(money.lease.rent), depositMinor: Number(money.lease.deposit), currency: money.currency, dueDay,
  };
}

export type TenantLeaseView =
  | { state: "error" }
  | { state: "empty" }
  | { state: "ready"; terms: TenantLeaseTerms; money: LeaseMoney; idGate: boolean; signedPdfs: Awaited<ReturnType<typeof tenantSignedLeasePdfs>> };

export type LeaseDeps = { money?: typeof tenantLeaseMoney; idCheck?: typeof loadLeaseIdCheck; signed?: typeof tenantSignedLeasePdfs; idRequired?: typeof identityRequiredForSigningFor };

/** `/t/lease` under brand_v3: the same four reads as the existing page, with the same arguments; a failed read is G-ERR. */
export async function tenantLeaseView(session: Session, leaseId: string, deps: LeaseDeps = {}): Promise<TenantLeaseView> {
  const readMoney = deps.money ?? tenantLeaseMoney, readIdCheck = deps.idCheck ?? loadLeaseIdCheck;
  const readSigned = deps.signed ?? tenantSignedLeasePdfs, readIdRequired = deps.idRequired ?? identityRequiredForSigningFor;
  try {
    const [money, idCheck, signedPdfs] = await Promise.all([readMoney(session, leaseId), readIdCheck(session, leaseId), readSigned(session, leaseId)]);
    const idRequired = await readIdRequired(session);
    if (!money) return { state: "empty" };
    return { state: "ready", terms: tenantLeaseTerms(money), money, idGate: Boolean(idCheck && !idCheck.ready && idRequired), signedPdfs };
  } catch (error) {
    logServerError("b090_tenant_lease", error);
    return { state: "error" };
  }
}
