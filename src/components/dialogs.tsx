"use client";

import { useState } from "react";
import { actionApproveMatch, actionImportCsv, actionRecordPayment, actionStatement } from "@/server/actions";
import { taipeiToday } from "@/server/money";
import { useT } from "./locale";

export function PayDialog({
  leaseId,
  dueMinor,
  currency,
  label,
  returnTo,
}: {
  leaseId: string;
  dueMinor: number;
  currency: string;
  label: string;
  returnTo: "staff" | "tenant";
}) {
  const t = useT();
  const [open, setOpen] = useState(returnTo === "tenant");
  const major = currency === "TWD" ? String(Math.round(dueMinor / 100)) : (dueMinor / 100).toFixed(2);
  const [amount, setAmount] = useState(major);
  const dialog = open ? (
    <div className="modal-bg" role="dialog">
      <form className="modal" action={actionRecordPayment}>
        <div className="hd">
          <h3>{label}</h3>
          <span className="sp" />
          {returnTo === "staff" ? (
            <button className="btn ghost" type="button" onClick={() => setOpen(false)}>
              {t("i_close")}
            </button>
          ) : null}
        </div>
        <div className="bd">
          <input type="hidden" name="leaseId" value={leaseId} />
          <input type="hidden" name="returnTo" value={returnTo === "tenant" ? "tenant" : "staff"} />
          <div className="fg">
            <label className="f">{t("i_amount_label")}</label>
            <input
              className="inp"
              name="amount"
              data-testid="pay-amount"
              data-minor={dueMinor}
              value={amount}
              inputMode="decimal"
              onChange={(event) => setAmount(event.target.value)}
            />
            <div className="hint">{t("i_pay_hint")}</div>
          </div>
          <div className="fg">
            <label className="f">{t("i_paid_on")}</label>
            <input className="inp" type="date" name="paidOn" defaultValue={taipeiToday()} />
          </div>
          <div className="fg">
            <label className="f">{t("i_last5")}</label>
            <input className="inp" name="last5" data-testid="pay-last5" defaultValue="" placeholder={t("i_ph_last5")} inputMode="numeric" />
          </div>
          <div className="fg">
            <label className="f">{t("i_reference")}</label>
            <input className="inp" name="reference" defaultValue="" />
          </div>
          <p className="small muted">{t("i_pay_direct", { brand: t("i_brand") })}</p>
        </div>
        <div className="ft">
          <button className="btn pri" type="submit" data-testid="submit-payment">
            {label}
          </button>
        </div>
      </form>
    </div>
  ) : null;
  if (returnTo === "tenant") return dialog;
  return (
    <>
      <button className="btn sm pri" type="button" data-testid="record-payment" onClick={() => setOpen(true)}>
        {label}
      </button>
      {dialog}
    </>
  );
}

export function StatementForm({
  owners,
  existing,
  month,
}: {
  owners: { id: string; name: string }[];
  existing: { ownerId: string; month: string }[];
  month: string;
}) {
  const t = useT();
  const [owner, setOwner] = useState("");
  const [value, setValue] = useState(month);
  const exists = existing.some((row) => row.ownerId === owner && row.month === `${value}-01`);
  return (
    <form action={actionStatement} className="card pad" style={{ maxWidth: 640 }}>
      <div className="fg">
        <label className="f">{t("i_owner")}</label>
        <select className="inp" name="ownerContactId" data-testid="statement-owner" value={owner} onChange={(event) => setOwner(event.target.value)}>
          <option value="">{t("i_choose")}</option>
          {owners.map((item) => (
            <option key={item.id} value={item.id}>
              {item.name}
            </option>
          ))}
        </select>
      </div>
      <div className="fg">
        <label className="f">{t("i_month")}</label>
        <input className="inp" type="month" name="month" data-testid="statement-month" value={value} onChange={(event) => setValue(event.target.value)} />
      </div>
      <p className="hint">{t("i_regenerate_hint")}</p>
      <button className="btn pri" type="submit" data-testid="submit-statement" disabled={!owner}>
        {exists ? t("s_1bd133f") : t("s_705a524")}
      </button>
    </form>
  );
}

export function BankImport({ sample }: { sample: string }) {
  const t = useT();
  const [csv, setCsv] = useState("");
  return (
    <form action={actionImportCsv} className="card pad">
      <p className="small">{t("i_bank_demo")}</p>
      <label className="f">{t("i_csv_label")}</label>
      <textarea className="inp" name="csv" data-testid="bank-csv" rows={6} value={csv} onChange={(event) => setCsv(event.target.value)} />
      <div className="row" style={{ marginTop: 10 }}>
        <button className="btn" type="button" data-testid="fill-sample" disabled={!sample} onClick={() => setCsv(sample)}>
          {t("i_sample")}
        </button>
        <button className="btn pri" type="submit" data-testid="submit-import">
          {t("i_import")}
        </button>
      </div>
    </form>
  );
}

export function ApproveForm({ id }: { id: string }) {
  const t = useT();
  return (
    <form action={actionApproveMatch}>
      <input type="hidden" name="suggestionId" value={id} />
      <button className="btn sm pri" type="submit" data-testid="approve-match">
        {t("i_approve")}
      </button>
    </form>
  );
}
