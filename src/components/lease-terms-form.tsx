"use client";

import { useActionState, useState } from "react";
import { errorText } from "@/i18n/errors";
import { actionUpdateLease } from "@/server/actions";
import { useT } from "./locale";

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
  const [state, formAction] = useActionState(actionUpdateLease, { error: "" });
  const [rentValue, setRentValue] = useState(rent);
  const [months, setMonths] = useState(monthsInput(depositMonths));
  const [reason, setReason] = useState(depositReason);
  const depositOver = Number(months) > 2;
  const blocked = depositOver && reason.trim() === "";

  return (
    <form
      className="card pad"
      style={{ marginTop: 16 }}
      data-testid="lease-terms"
      action={formAction}
      onSubmit={(event) => {
        if (blocked) event.preventDefault();
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
      {depositOver ? (
        <div className="alert warn" data-testid="deposit-alert">
          <div>{t("lease_deposit_over", { months, cap: 2 })}</div>
          <label className="f" style={{ marginTop: 8 }}>{t("lease_deposit_reason")}</label>
          <textarea
            className="inp"
            name="depositReason"
            data-testid="deposit-reason"
            placeholder={t("lease_ph_deposit_reason")}
            value={reason}
            onChange={(event) => setReason(event.target.value)}
          />
        </div>
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
      <button className="btn pri" type="submit" data-testid="save-lease-terms" disabled={blocked} style={{ marginTop: 12 }}>
        {t("i_save")}
      </button>
    </form>
  );
}
