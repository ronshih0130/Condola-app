"use client";

import { useEffect, useId, useRef, useState } from "react";
import { actionApproveMatch, actionImportCsv, actionRecordPayment, actionStatement } from "@/server/actions";
import { taipeiToday } from "@/server/money";
import { useT } from "./locale";

type ScrollMark = { el: HTMLElement | Window; left: number; top: number };

function captureScroll(from: HTMLElement | null): ScrollMark[] {
  const marks: ScrollMark[] = [{ el: window, left: window.scrollX, top: window.scrollY }];
  let node = from?.parentElement ?? null;
  while (node) {
    const style = window.getComputedStyle(node);
    if (/(auto|scroll|overlay)/.test(`${style.overflowY} ${style.overflowX}`)) {
      marks.push({ el: node, left: node.scrollLeft, top: node.scrollTop });
    }
    node = node.parentElement;
  }
  return marks;
}

function restoreScroll(marks: ScrollMark[]) {
  for (const mark of marks) {
    const el = mark.el;
    if (!(el instanceof HTMLElement)) {
      window.scrollTo(mark.left, mark.top);
      continue;
    }
    if (el.isConnected) el.scrollTo(mark.left, mark.top);
  }
}

/** Keep the saved position through the browser's focus scroll, which can land a frame later. */
function restoreAndHold(marks: ScrollMark[]) {
  restoreScroll(marks);
  const until = performance.now() + 500;
  const onScroll = () => {
    if (performance.now() > until) {
      window.removeEventListener("scroll", onScroll, true);
      return;
    }
    restoreScroll(marks);
  };
  window.addEventListener("scroll", onScroll, true);
  window.setTimeout(() => window.removeEventListener("scroll", onScroll, true), 520);
}

export function PayDialog({
  leaseId,
  dueMinor,
  currency,
  label,
  returnTo,
  status,
  requestScope,
}: {
  leaseId: string;
  dueMinor: number;
  currency: string;
  label: string;
  returnTo: "staff" | "tenant";
  status?: string;
  requestScope?: { actorId:string; orgId:string; copy:{checking:string; recorded:string; unknown:string; unavailable:string; newPayment:string} };
}) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const paymentRequestId = useRef("");
  const [requestStatus, setRequestStatus] = useState<"checking" | "recorded" | "unknown" | "unavailable">("checking");
  const [requestCheck, setRequestCheck] = useState(0);
  const storageKey = requestScope ? `condola:payment-request:${requestScope.actorId}:${requestScope.orgId}:${leaseId}` : null;
  const titleId = useId();
  const triggerRef = useRef<HTMLButtonElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const scrollMarks = useRef<ScrollMark[]>([]);
  const major = currency === "TWD" ? String(Math.round(dueMinor / 100)) : (dueMinor / 100).toFixed(2);
  const [amount, setAmount] = useState(major);

  useEffect(() => {
    if (!open) return;
    const marks = scrollMarks.current;
    const trigger = triggerRef.current;
    const dialog = dialogRef.current;
    dialog?.focus({ preventScroll: true });
    restoreScroll(marks);
    function onKey(event: KeyboardEvent) {
      if (event.key !== "Escape") return;
      event.preventDefault();
      setOpen(false);
    }
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("keydown", onKey);
      scrollMarks.current = [];
      restoreScroll(marks);
      trigger?.focus({ preventScroll: true });
      restoreAndHold(marks);
    };
  }, [open]);

  useEffect(() => {
    if (!open || !storageKey || !paymentRequestId.current) return;
    let current = true;
    setRequestStatus("checking");
    fetch("/api/payments/request-status", { method:"POST", headers:{"Content-Type":"application/json"}, cache:"no-store", body:JSON.stringify({leaseId,requestId:paymentRequestId.current}) })
      .then(async response => response.ok ? response.json() as Promise<{status:unknown}> : Promise.reject(new Error("unavailable")))
      .then(result => { if (current) setRequestStatus(result.status === "recorded" || result.status === "unknown" ? result.status : "unavailable"); })
      .catch(() => { if (current) setRequestStatus("unavailable"); });
    return () => { current = false; };
  }, [open, storageKey, leaseId, requestCheck]);

  function rememberScroll() {
    scrollMarks.current = captureScroll(triggerRef.current);
  }

  function openDialog() {
    if (storageKey) {
      try {
        let id = sessionStorage.getItem(storageKey);
        if (!id) {
          const count = Array.from({length:sessionStorage.length}, (_,i) => sessionStorage.key(i)).filter(key => key?.startsWith("condola:payment-request:")).length;
          if (count >= 40) throw new Error("storage full");
          id = crypto.randomUUID();
          sessionStorage.setItem(storageKey,id);
        }
        if (!/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(id)) throw new Error("invalid request");
        paymentRequestId.current = id;
        setRequestStatus("checking");
      } catch { paymentRequestId.current = ""; setRequestStatus("unavailable"); }
    } else if (!paymentRequestId.current) paymentRequestId.current = crypto.randomUUID();
    if (scrollMarks.current.length === 0) rememberScroll();
    setOpen(true);
  }

  function newPayment() {
    if (!storageKey || requestStatus !== "recorded") return;
    try {
      const id=crypto.randomUUID();
      sessionStorage.setItem(storageKey,id);
      paymentRequestId.current=id;
      setRequestStatus("unknown");
    } catch { setRequestStatus("unavailable"); }
  }

  const dialog = open ? (
    <div
      className="modal-bg"
      role="dialog"
      aria-modal="true"
      aria-labelledby={titleId}
      ref={dialogRef}
      tabIndex={-1}
      onClick={(event) => {
        if (event.target === event.currentTarget) setOpen(false);
      }}
    >
      <form className="modal" action={actionRecordPayment} onClick={(event) => event.stopPropagation()}>
        <div className="hd">
          <h3 id={titleId}>{label}</h3>
          <span className="sp" />
          <button className="btn ghost" type="button" data-testid="pay-dialog-close" aria-label={t("i_close")} onClick={() => setOpen(false)}>
            ✕
          </button>
        </div>
        <div className="bd">
          <input type="hidden" name="leaseId" value={leaseId} />
          <input type="hidden" name="requestId" value={paymentRequestId.current} />
          <input type="hidden" name="returnTo" value={returnTo === "tenant" ? "tenant" : "staff"} />
          {requestScope ? <div className="alert" data-testid="payment-request-status">{requestScope.copy[requestStatus]} {requestStatus === "recorded" ? <button className="btn sm" type="button" data-testid="payment-new-intent" onClick={newPayment}>{requestScope.copy.newPayment}</button> : null} {requestStatus === "unavailable" && paymentRequestId.current ? <button className="btn sm" type="button" onClick={() => setRequestCheck(n=>n+1)}>{requestScope.copy.checking}</button> : null}</div> : null}
          {status ? (
            <div className="alert" data-testid="pay-status">
              {status}
            </div>
          ) : null}
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
            <div className="hint">{t(returnTo === "tenant" ? "i_pay_hint_tenant" : "i_pay_hint")}</div>
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
          <button className="btn pri" type="submit" data-testid="submit-payment" disabled={Boolean(requestScope && requestStatus !== "unknown")}>
            {label}
          </button>
        </div>
      </form>
    </div>
  ) : null;
  return (
    <>
      <button ref={triggerRef} className="btn sm pri" type="button" data-testid="record-payment" onPointerDown={rememberScroll} onClick={openDialog}>
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
  canGenerate = true,
  deniedReason = "",
}: {
  owners: { id: string; name: string }[];
  existing: { ownerId: string; month: string }[];
  month: string;
  canGenerate?: boolean;
  deniedReason?: string;
}) {
  const t = useT();
  const [owner, setOwner] = useState("");
  const [value, setValue] = useState(month);
  const exists = existing.some((row) => row.ownerId === owner && row.month === `${value}-01`);
  return (
    <form action={canGenerate ? actionStatement : undefined} className="card pad" style={{ maxWidth: 640 }}>
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
      <button
        className="btn pri"
        type="submit"
        data-testid="submit-statement"
        disabled={!owner || !canGenerate}
        title={canGenerate ? undefined : deniedReason}
        aria-disabled={!canGenerate}
      >
        {exists ? t("s_1bd133f") : t("s_705a524")}
      </button>
      {!canGenerate ? <p className="hint">{deniedReason}</p> : null}
    </form>
  );
}

/** Same action binding as the list form. A server-rendered form on the preview page did not submit. */
export function PreviewGenerateForm({ ownerId, month, label, fingerprint }: { ownerId: string; month: string; label: string; fingerprint?: string }) {
  return (
    <form action={actionStatement}>
      <input type="hidden" name="ownerContactId" value={ownerId} />
      <input type="hidden" name="month" value={month} />
      {fingerprint ? <input type="hidden" name="previewFingerprint" value={fingerprint} /> : null}
      <button className="btn pri" type="submit" data-testid="preview-generate" formAction={actionStatement}>
        {label}
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
