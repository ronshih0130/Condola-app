"use client";

import { useState } from "react";
import Link from "next/link";
import { actionRenewLease } from "@/server/actions";
import {
  COPY,
  depositConfirm,
  depositDecreaseHint,
  depositIncreaseHint,
  dueDayLabel,
  nt,
  oldLeaseNote,
  renewalDatesOk,
} from "@/server/lease-lifecycle-rules";

export function LeaseRenewForm({
  leaseId,
  oldEnd,
  rentMajor,
  depositMajor,
  start,
  end,
}: {
  leaseId: string;
  oldEnd: string;
  rentMajor: number;
  depositMajor: number;
  start: string;
  end: string;
}) {
  const [step, setStep] = useState<1 | 2>(1);
  const [startDate, setStartDate] = useState(start);
  const [endDate, setEndDate] = useState(end);
  const [rent, setRent] = useState(String(rentMajor));
  const [deposit, setDeposit] = useState(String(depositMajor));
  const [dueDay, setDueDay] = useState(5);
  const [reason, setReason] = useState("");
  const rentValue = Number(rent);
  const depositValue = Number(deposit);
  const datesOk = renewalDatesOk(oldEnd, startDate, endDate);
  const moneyOk = Number.isInteger(rentValue) && rentValue > 0 && Number.isInteger(depositValue) && depositValue >= 0;
  const months = moneyOk ? depositValue / rentValue : 0;
  const overCap = months > 2;
  const delta = moneyOk ? depositValue - depositMajor : 0;
  const canNext = datesOk && moneyOk && (!overCap || reason.trim() !== "");

  return (
    <form action={actionRenewLease} data-testid="renew-form">
      <div className="steps" data-testid="renew-steps">
        <span className={`s${step === 1 ? " on" : " done"}`}>{step > 1 ? `✓ ${COPY.stepTerms}` : COPY.stepTerms}</span>
        <span className={`s${step === 2 ? " on" : ""}`}>{COPY.stepConfirm}</span>
      </div>
      <input type="hidden" name="leaseId" value={leaseId} />
      <input type="hidden" name="startDate" value={startDate} />
      <input type="hidden" name="endDate" value={endDate} />
      <input type="hidden" name="rent" value={rent} />
      <input type="hidden" name="deposit" value={deposit} />
      <input type="hidden" name="dueDay" value={dueDay} />
      <input type="hidden" name="depositReason" value={reason} />
      {step === 1 ? (
        <div className="card pad" data-testid="renew-terms">
          <div className="grid2">
            <div className="fg">
              <label className="f">{COPY.newStart}</label>
              <input className="inp" type="date" data-testid="renew-start" value={startDate} min={oldEnd} onChange={(event) => setStartDate(event.target.value)} required />
            </div>
            <div className="fg">
              <label className="f">{COPY.newEnd}</label>
              <input className="inp" type="date" data-testid="renew-end" value={endDate} min={startDate} onChange={(event) => setEndDate(event.target.value)} required />
            </div>
          </div>
          <h3>{COPY.rentSection}</h3>
          <div className="grid2">
            <div className="fg">
              <label className="f">{COPY.oldRent}</label>
              <p data-testid="renew-old-rent">{nt(rentMajor)}</p>
            </div>
            <div className="fg">
              <label className="f">{COPY.newRent}</label>
              <input className="inp" inputMode="numeric" data-testid="renew-rent" value={rent} onChange={(event) => setRent(event.target.value)} required />
            </div>
          </div>
          <div className="fg">
            <label className="f" htmlFor="renew-due-day">{dueDayLabel(dueDay)}</label>
            <select id="renew-due-day" className="inp" data-testid="renew-due-day" value={dueDay} onChange={(event) => setDueDay(Number(event.target.value))}>
              {Array.from({ length: 28 }, (_, index) => index + 1).map((day) => (
                <option key={day} value={day}>{dueDayLabel(day)}</option>
              ))}
            </select>
          </div>
          <h3>{COPY.depositSection}</h3>
          <div className="grid2">
            <div className="fg">
              <label className="f">{COPY.oldDeposit}</label>
              <p data-testid="renew-old-deposit">{nt(depositMajor)}</p>
            </div>
            <div className="fg">
              <label className="f">{COPY.newDeposit}</label>
              <input className="inp" inputMode="numeric" data-testid="renew-deposit" value={deposit} onChange={(event) => setDeposit(event.target.value)} required />
            </div>
          </div>
          {delta > 0 ? <p className="small" data-testid="deposit-increase">{depositIncreaseHint(nt(delta))}</p> : null}
          {delta < 0 ? <p className="small" data-testid="deposit-decrease">{depositDecreaseHint(nt(Math.abs(delta)))}</p> : null}
          {overCap ? (
            <div className="fg">
              <label className="f">超過兩個月的原因</label>
              <input className="inp" data-testid="renew-deposit-reason" value={reason} onChange={(event) => setReason(event.target.value)} />
            </div>
          ) : null}
          <div className="row" style={{ marginTop: 16 }}>
            <Link className="btn" href="/m/leases/expiring">{COPY.cancel}</Link>
            <span className="sp" />
            <button className="btn pri" type="button" data-testid="renew-next" disabled={!canNext} onClick={() => setStep(2)}>{COPY.next}</button>
          </div>
        </div>
      ) : (
        <div className="card pad" data-testid="renew-confirm">
          <h3>{COPY.confirmTitle}</h3>
          <table className="t">
            <tbody>
              <tr>
                <td>{COPY.term}</td>
                <td data-testid="confirm-term">{startDate} – {endDate}</td>
              </tr>
              <tr>
                <td>{COPY.monthlyRent}</td>
                <td data-testid="confirm-rent">{nt(rentValue)}</td>
              </tr>
              <tr>
                <td>{COPY.deposit}</td>
                <td data-testid="confirm-deposit">{depositConfirm(nt(depositValue), nt(Math.abs(delta)))}</td>
              </tr>
              <tr>
                <td>{COPY.oldLease}</td>
                <td data-testid="confirm-old">{oldLeaseNote(oldEnd)}</td>
              </tr>
              <tr>
                <td>{dueDayLabel(dueDay)}</td>
                <td>{dueDayLabel(dueDay)}</td>
              </tr>
            </tbody>
          </table>
          <div className="row" style={{ marginTop: 16 }}>
            <button className="btn" type="button" data-testid="renew-back" onClick={() => setStep(1)}>{COPY.back}</button>
            <span className="sp" />
            <button className="btn pri" type="submit" data-testid="renew-create">{COPY.create}</button>
          </div>
        </div>
      )}
    </form>
  );
}
