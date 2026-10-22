"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { actionScheduleMoveOut } from "@/server/actions";
import {
  COPY,
  endReasonLabel,
  midTermHint,
  moveOutDateOk,
  moveOutRentSpan,
  moveOutTooEarly,
  overrideNote,
  prorateRentMajor,
  rentFormula,
  type EndReason,
} from "@/server/lease-lifecycle-rules";

export function LeaseMoveOutWizard({
  leaseId,
  startDate,
  endDate,
  rentMajor,
}: {
  leaseId: string;
  startDate: string;
  endDate: string;
  rentMajor: number;
}) {
  const [step, setStep] = useState<1 | 2>(1);
  const [moveOutOn, setMoveOutOn] = useState(endDate < startDate ? startDate : endDate);
  const [reason, setReason] = useState<EndReason>(endDate > startDate ? "early" : "expired");
  const [override, setOverride] = useState("");
  const [handover, setHandover] = useState(`${endDate}T10:00`);
  const span = useMemo(() => (moveOutDateOk(startDate, moveOutOn) ? moveOutRentSpan(startDate, moveOutOn) : null), [startDate, moveOutOn]);
  const defaultMajor = span ? prorateRentMajor(rentMajor, span.days) : null;
  const typed = override.trim() === "" ? null : Number(override);
  const overrideMajor = typed != null && Number.isInteger(typed) && typed >= 0 && defaultMajor != null && typed !== defaultMajor ? typed : null;
  const shown = overrideMajor ?? defaultMajor;
  const dateBad = moveOutOn !== "" && !moveOutDateOk(startDate, moveOutOn);
  const mid = Boolean(span && moveOutOn < endDate && shown != null);

  return (
    <form action={actionScheduleMoveOut} data-testid="moveout-form">
      <div className="steps" data-testid="moveout-steps">
        <span className={`s${step === 1 ? " on" : " done"}`}>{step > 1 ? `✓ ${COPY.stepDate}` : COPY.stepDate}</span>
        <span className={`s${step === 2 ? " on" : ""}`}>{COPY.stepHandover}</span>
        <span className="s">{COPY.stepSettle}</span>
      </div>
      <input type="hidden" name="leaseId" value={leaseId} />
      <input type="hidden" name="moveOutOn" value={moveOutOn} />
      <input type="hidden" name="reason" value={reason} />
      <input type="hidden" name="override" value={overrideMajor == null ? "" : String(overrideMajor)} />
      <input type="hidden" name="handover" value={handover} />
      {step === 1 ? (
        <div className="card pad" data-testid="moveout-date-step">
          <div className="grid2">
            <div className="fg">
              <label className="f">{COPY.moveOutDate}</label>
              <input className="inp" type="date" data-testid="move-out-date" min={startDate} value={moveOutOn} onChange={(event) => setMoveOutOn(event.target.value)} required />
            </div>
            <div className="fg">
              <label className="f">{COPY.reason}</label>
              <select className="inp" data-testid="move-out-reason" value={reason} onChange={(event) => setReason(event.target.value as EndReason)}>
                <option value="expired">{endReasonLabel("expired")}</option>
                <option value="early">{endReasonLabel("early")}</option>
                <option value="other">{endReasonLabel("other")}</option>
              </select>
            </div>
          </div>
          {dateBad ? <p className="alert bad" data-testid="move-out-date-error">{moveOutTooEarly(startDate)}</p> : null}
          {span && defaultMajor != null && shown != null ? (
            <>
              {mid ? <p data-testid="mid-term-hint">{midTermHint(moveOutOn, defaultMajor)}</p> : null}
              <p data-testid="rent-formula">{rentFormula(rentMajor, span.days, defaultMajor)}</p>
              <div className="fg">
                <label className="f">{COPY.moveOutRent}</label>
                <input className="inp" inputMode="numeric" data-testid="move-out-rent" value={override} placeholder={String(defaultMajor)} onChange={(event) => setOverride(event.target.value)} />
              </div>
              {overrideMajor != null ? <p data-testid="override-note">{overrideNote(defaultMajor, overrideMajor)}</p> : null}
            </>
          ) : null}
          <div className="row" style={{ marginTop: 16 }}>
            <Link className="btn" href="/m/leases/expiring">{COPY.cancel}</Link>
            <span className="sp" />
            <button className="btn pri" type="button" data-testid="moveout-next" disabled={!span || defaultMajor == null} onClick={() => { setHandover(`${moveOutOn}T10:00`); setStep(2); }}>{COPY.next}</button>
          </div>
        </div>
      ) : (
        <div className="card pad" data-testid="moveout-handover-step">
          <div className="fg">
            <label className="f">{COPY.handover}</label>
            <input className="inp" type="datetime-local" data-testid="handover-at" value={handover} onChange={(event) => setHandover(event.target.value)} required />
          </div>
          <div className="row" style={{ marginTop: 16 }}>
            <button className="btn" type="button" onClick={() => setStep(1)}>{COPY.back}</button>
            <span className="sp" />
            <button className="btn pri" type="submit" data-testid="schedule-moveout">{COPY.schedule}</button>
          </div>
        </div>
      )}
    </form>
  );
}
