"use client";

import { useActionState, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { errorText } from "@/i18n/errors";
import { actionUpdateLease, type ActionState } from "@/server/actions";
import { actionDepositPolicy } from "@/server/deposit-rules-actions";
import { depositPolicyCap, depositPolicyState, type DepositPolicy } from "@/server/deposit-rules";
import { useT } from "./locale";
import { callSubmitAction, claimFormSubmit, releaseFormSubmit } from "./submit-once";

function monthsInput(value: string) {
  if (!value.trim()) return "";
  const parsed = Number(value);
  return Number.isFinite(parsed) ? String(parsed) : value;
}

export function LeaseTermsForm({
  leaseId,
  rent,
  depositMonths,
  depositReason,
  updatedAt,
}: {
  leaseId: string;
  rent: string;
  depositMonths: string;
  depositReason: string;
  updatedAt: string;
}) {
  const t = useT();
  const router = useRouter();
  const guard = useRef(false);
  const [state, formAction, pending] = useActionState(
    (prev: ActionState, formData: FormData) =>
      callSubmitAction(
        guard,
        () => actionUpdateLease(prev, formData),
        (): ActionState => ({ error: "errors.leaseFailed" }),
      ),
    { error: "" },
  );
  const [rentValue, setRentValue] = useState(rent);
  const [months, setMonths] = useState(monthsInput(depositMonths));
  const [reason, setReason] = useState("");
  const [policy, setPolicy] = useState<DepositPolicy | null>(null);
  const wasPending = useRef(false);
  const policyState = policy ? depositPolicyState(policy, Number(months)) : "none";
  const cap = policy ? depositPolicyCap(policy, Number(months)) : null;
  const showReason = policyState === "reason" && (Number(months) !== Number(depositMonths) || Number(rentValue) !== Number(rent) || !depositReason.trim());
  const blocked = !policy || policyState === "block" || (showReason && reason.trim() === "");

  useEffect(() => {
    let cancelled = false;
    setPolicy(null);
    void actionDepositPolicy({ leaseId }).then((value) => { if (!cancelled) setPolicy(value); })
      .catch(() => { if (!cancelled) setPolicy(null); });
    return () => { cancelled = true; };
  }, [leaseId]);

  useEffect(() => {
    if (!pending && state.error) releaseFormSubmit(guard);
    if (wasPending.current && !pending && !state.error) router.refresh();
    wasPending.current = pending;
  }, [pending, state.error, router]);

  return (
    <form
      className="card pad"
      style={{ marginTop: 16 }}
      data-testid="lease-terms"
      action={formAction}
      onSubmit={(event) => {
        if (blocked || pending || !claimFormSubmit(guard)) event.preventDefault();
      }}
    >
      <h3>{t("i_edit")}</h3>
      {state.error ? (
        <div className="alert bad" data-testid="lease-error" style={{ marginBottom: 12 }}>
          {state.field && (state.error === "errors.required" || state.error === "errors.amount")
            ? t("i_field_incomplete", { field: t(state.field) })
            : errorText(t, state.error)}
        </div>
      ) : null}
      <input type="hidden" name="leaseId" value={leaseId} />
      <input type="hidden" name="updatedAt" value={updatedAt} />
      <div className="grid2">
        <div className="fg">
          <label className="f">{t("i_base_rent")}</label>
          <input
            className="inp"
            name="rent"
            data-testid="edit-rent"
            inputMode="decimal"
            value={rentValue}
            onChange={(event) => setRentValue(event.target.value)}
          />
        </div>
        <div className="fg">
          <label className="f">{t("s_8ed103e")}</label>
          <input
            className="inp"
            name="depositMonths"
            data-testid="deposit-months"
            inputMode="decimal"
            value={months}
            onChange={(event) => setMonths(event.target.value)}
          />
        </div>
      </div>
      {!policy ? <p className="hint">{t("deposit_policy_checking")}</p> : null}
      {policy?.regionalEnabled && policy.maxMonths === null ? <p className="hint">{t("deposit_policy_missing")}</p> : null}
      {policyState === "warn" || policyState === "block" ? <p className="alert warn">{t(policyState === "warn" ? "deposit_policy_warn" : "deposit_policy_block", { cap: cap ?? 0 })}</p> : null}
      {showReason ? (
        <div className="alert warn" data-testid="deposit-alert" style={{ display: "block" }}>
          <div>{t("lease_deposit_over", { months, cap: cap ?? 0 })}</div>
          <label className="f" style={{ marginTop: 8 }}>{t("deposit_policy_reason")}</label>
          <textarea
            className="inp"
            name="depositReason"
            data-testid="deposit-reason"
            placeholder={t("lease_ph_deposit_reason")}
            value={reason}
            onChange={(event) => setReason(event.target.value)}
          />
        </div>
      ) : policyState === "reason" ? (
        <input type="hidden" name="depositReason" value={depositReason} />
      ) : (
        <>
          {depositReason.trim() ? (
            <p className="small muted" data-testid="deposit-reason-kept">
              {t("lease_deposit_reason_kept", { reason: depositReason.trim() })}
            </p>
          ) : null}
          <input type="hidden" name="depositReason" value="" />
        </>
      )}
      <button className="btn pri" type="submit" data-testid="save-lease-terms" disabled={blocked || pending} aria-busy={pending || undefined} style={{ marginTop: 12 }}>
        {pending ? t("i_portal_working") : t("i_save")}
      </button>
    </form>
  );
}
