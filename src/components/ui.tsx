import { errorText } from "@/i18n/errors";
import type { T } from "@/i18n";

export function Stepper({ steps, current }: { steps: string[]; current: number }) {
  return (
    <div className="steps">
      {steps.map((label, index) => {
        const number = index + 1;
        const done = number < current;
        const on = number === current;
        return (
          <span key={label} className={`s${on ? " on" : ""}${done ? " done" : ""}`}>
            {done ? `✓ ${label}` : `${number}. ${label}`}
          </span>
        );
      })}
    </div>
  );
}

export function PageHeader({
  title,
  crumb,
  actions,
}: {
  title: React.ReactNode;
  crumb?: React.ReactNode;
  actions?: React.ReactNode;
}) {
  return (
    <div className="ph">
      <div>
        {crumb ? <div className="crumb">{crumb}</div> : null}
        <h1>{title}</h1>
      </div>
      <span className="sp" />
      {actions}
    </div>
  );
}

export function ErrorBanner({ t, error }: { t: T; error?: string }) {
  if (!error) return null;
  return (
    <div className="alert bad" data-testid="error-banner" style={{ marginBottom: 12 }}>
      {errorText(t, error)}
    </div>
  );
}

export function Empty({ children }: { children: React.ReactNode }) {
  return <div className="empty">{children}</div>;
}

export function chargeKey(type: string) {
  if (type === "rent") return "i_charge_rent";
  if (type === "deposit") return "i_charge_deposit";
  if (type === "utility") return "i_charge_utility";
  return "i_charge_other";
}

export function statusKey(status: string) {
  const map: Record<string, string> = {
    draft: "i_st_draft",
    pending_signature: "i_st_pending",
    active: "i_st_active",
    ended: "i_st_ended",
    terminated: "i_st_terminated",
    cancelled: "i_st_cancelled",
    open: "i_st_open",
    triaged: "i_st_triaged",
    assigned: "i_st_assigned",
    in_progress: "i_st_progress",
    on_hold: "i_st_hold",
    resolved: "i_st_resolved",
    closed: "i_st_closed",
    sent: "i_esign_sent",
    partially_signed: "i_esign_partial",
    fully_signed: "i_esign_full",
    submitted: "i_pay_submitted",
    confirmed: "i_pay_confirmed",
    rejected: "i_pay_rejected",
    issued: "i_issued",
  };
  return map[status] ?? "i_status";
}

export function statusClass(status: string) {
  if (["active", "confirmed", "fully_signed", "resolved", "closed", "issued"].includes(status)) return "ok";
  if (["rejected", "terminated", "cancelled", "open"].includes(status) && status !== "open") return "bad";
  if (["pending_signature", "submitted", "partially_signed", "in_progress", "on_hold"].includes(status)) return "warn";
  if (status === "open") return "warn";
  return "";
}
