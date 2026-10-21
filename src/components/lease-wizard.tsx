"use client";

import { useActionState, useEffect, useMemo, useRef, useState } from "react";
import { errorText } from "@/i18n/errors";
import { confirmDeposit, confirmSpace, confirmSpaceFromSnapshot, depositMonthsOnHalfStep, formatMajor, nextSpaceSnapshot, twdRentIsWhole } from "@/lease-confirm";
import { actionCreateLease } from "@/server/actions";
import type { RoomOption } from "@/server/queries";
import { activeTenantPick, filterTenants, tenantByEmail, type TenantOption } from "@/tenant-pick";
import { useLocale, useT } from "./locale";
import { Stepper } from "./ui";
import { ImplicitSubmitSink, blockImplicitEnter } from "./form-enter";
import { claimFormSubmit, releaseFormSubmit } from "./submit-once";

function amountOk(raw: string) {
  const trimmed = raw.trim();
  if (!trimmed) return false;
  const value = Number(trimmed);
  return Number.isFinite(value) && value >= 0;
}

function money(major: number, currency: string, locale: string) {
  return formatMajor(major, currency, locale);
}

export function LeaseWizard({
  rooms,
  tenants,
  firmLocale,
}: {
  rooms: RoomOption[];
  tenants: TenantOption[];
  firmLocale: "zh-TW" | "en";
}) {
  const t = useT();
  const locale = useLocale();
  const [state, formAction, pending] = useActionState(actionCreateLease, { error: "" });
  const submitGuard = useRef(false);
  const [submitReady, setSubmitReady] = useState(false);
  const [slowSubmit, setSlowSubmit] = useState(false);
  const armSubmit = useRef<number | null>(null);
  const slowTimer = useRef<number | null>(null);
  const steps = [
    t("s_4fabbda"),
    t("s_74f19b0"),
    t("s_20a5de5"),
    t("s_8b17769"),
    t("s_6f40057"),
    t("s_0343f73"),
    t("s_a611841"),
    t("s_642b1c1"),
  ];
  const [step, setStep] = useState(1);
  const [roomId, setRoomId] = useState("");
  const [space, setSpace] = useState<RoomOption | null>(null);
  const [tenantMode, setTenantMode] = useState<"new" | "existing">("new");
  const [tenantContactId, setTenantContactId] = useState("");
  const [tenantQuery, setTenantQuery] = useState("");
  const [tenant, setTenant] = useState("");
  const [tenantEmail, setTenantEmail] = useState("");
  const [duplicateTenant, setDuplicateTenant] = useState<TenantOption | null>(null);
  const [phone, setPhone] = useState("");
  const [lineId, setLineId] = useState("");
  const [rent, setRent] = useState("");
  const [months, setMonths] = useState("");
  const [start, setStart] = useState("");
  const [depositMonths, setDepositMonths] = useState("");
  const [depositReason, setDepositReason] = useState("");
  const [dueDay, setDueDay] = useState("");
  const [split, setSplit] = useState("");
  const [bill, setBill] = useState("");
  const [usage, setUsage] = useState("");
  const [rate, setRate] = useState("");
  const [reason, setReason] = useState("");
  const [templateLang, setTemplateLang] = useState<"zh-TW" | "en">(firmLocale === "en" ? "en" : "zh-TW");
  const [bilingual, setBilingual] = useState(false);
  const [tenantError, setTenantError] = useState(false);
  const [phoneError, setPhoneError] = useState(false);
  const [tenantPickError, setTenantPickError] = useState(false);
  const [rentError, setRentError] = useState(false);
  const [depositError, setDepositError] = useState<false | "incomplete" | "step">(false);
  const [dueError, setDueError] = useState(false);
  const [billError, setBillError] = useState(false);
  const [usageError, setUsageError] = useState(false);
  const [rateError, setRateError] = useState(false);

  const room = rooms.find((item) => item.id === roomId) ?? (space?.id === roomId ? space : undefined);
  const summary = confirmSpaceFromSnapshot(roomId, space);
  const tenantMatches = useMemo(() => filterTenants(tenants, tenantQuery), [tenants, tenantQuery]);
  const pickedId = activeTenantPick(tenantContactId, tenantMatches);
  const pickedTenant = tenants.find((item) => item.id === pickedId) ?? null;
  const currency = room?.currency ?? "TWD";
  const billN = Number(bill);
  const usageN = Number(usage);
  const rateN = Number(rate);
  const average = usageN > 0 && bill !== "" ? billN / usageN : null;
  const over = average !== null && rate !== "" && rateN > average + 1e-9;
  const depositOver = Number(depositMonths) > 2;
  const depositBlocked = depositOver && depositReason.trim() === "";
  const blocked = depositBlocked || (step >= 6 && (split === "" || (over && reason.trim() === "")));

  const preview = useMemo(() => {
    if (!room || !(usageN > 0) || rate === "") return null;
    if (split === "sub_meter" && bill.trim() === "") return null;
    const charged = usageN * rateN;
    const shareRooms = room.unitRooms.length ? room.unitRooms : [{ id: room.id, label: room.unitLabel }];
    const count = shareRooms.length;
    return {
      charged,
      bill: Number.isFinite(billN) ? billN : 0,
      shares: shareRooms.map((item) => ({ label: item.label, amount: charged / count })),
    };
  }, [room, usageN, rate, rateN, billN, split, bill]);

  useEffect(() => {
    if (!pending && state.error) {
      releaseFormSubmit(submitGuard);
      if (slowTimer.current) window.clearTimeout(slowTimer.current);
      slowTimer.current = null;
      setSlowSubmit(false);
    }
  }, [pending, state.error]);

  useEffect(() => {
    if (!slowSubmit || pending || state.error) return;
    releaseFormSubmit(submitGuard);
  }, [slowSubmit, pending, state.error]);

  useEffect(() => {
    return () => {
      if (slowTimer.current) window.clearTimeout(slowTimer.current);
    };
  }, []);

  function chooseRoom(id: string) {
    setRoomId(id);
    setSpace((current) => nextSpaceSnapshot(rooms, id, current));
  }

  function chooseNewTenant() {
    setTenantMode("new");
    setTenantContactId("");
    setTenant("");
    setPhone("");
    setLineId("");
    setTenantQuery("");
    setTenantEmail("");
    setDuplicateTenant(null);
    setTenantError(false);
    setPhoneError(false);
    setTenantPickError(false);
  }

  function adoptTenant(match: TenantOption) {
    setTenantMode("existing");
    setTenantContactId(match.id);
    setTenant(match.name);
    setPhone(match.phone ?? "");
    setLineId("");
    setTenantQuery(match.name);
    setTenantEmail("");
    setDuplicateTenant(null);
    setTenantError(false);
    setPhoneError(false);
    setTenantPickError(false);
  }

  function noteTenantEmail(value: string) {
    setTenantEmail(value);
    setDuplicateTenant(tenantByEmail(tenants, value));
  }

  function chooseExistingTenant() {
    setTenantMode("existing");
    setTenant("");
    setPhone("");
    setLineId("");
    setTenantError(false);
    setPhoneError(false);
  }

  function goNext() {
    if (step === 2) {
      if (tenantMode === "existing") {
        const missing = pickedId === "";
        setTenantPickError(missing);
        if (missing) return;
      } else {
        const nameBad = tenant.trim() === "";
        const phoneBad = phone.trim() === "";
        const duplicate = tenantByEmail(tenants, tenantEmail);
        setTenantError(nameBad);
        setPhoneError(phoneBad);
        setDuplicateTenant(duplicate);
        if (nameBad || phoneBad || duplicate) return;
      }
    }
    if (step === 3 && (!amountOk(rent) || !twdRentIsWhole(currency, Number(rent)))) {
      setRentError(true);
      return;
    }
    if (step === 4) {
      if (!amountOk(depositMonths)) {
        setDepositError("incomplete");
        return;
      }
      if (!depositMonthsOnHalfStep(Number(depositMonths))) {
        setDepositError("step");
        return;
      }
    }
    if (step === 5) {
      const day = Number(dueDay);
      if (!dueDay.trim() || !Number.isInteger(day) || day < 1 || day > 31) {
        setDueError(true);
        return;
      }
    }
    if (step === 6) {
      const anyElectricity = bill.trim() !== "" || usage.trim() !== "" || rate.trim() !== "";
      if (anyElectricity) {
        const billBad = !amountOk(bill);
        const usageBad = !usage.trim() || !(Number(usage) > 0);
        const rateBad = rate.trim() !== "" && !amountOk(rate);
        setBillError(billBad);
        setUsageError(usageBad);
        setRateError(rateBad);
        if (billBad || usageBad || rateBad) return;
      }
    }
    const next = step + 1;
    if (next === 8) {
      setSubmitReady(false);
      if (armSubmit.current) window.clearTimeout(armSubmit.current);
      armSubmit.current = window.setTimeout(() => setSubmitReady(true), 600);
    }
    setStep(next);
  }

  function goBack() {
    if (armSubmit.current) window.clearTimeout(armSubmit.current);
    armSubmit.current = null;
    setSubmitReady(false);
    setStep(step - 1);
  }

  return (
    <form
      action={formAction}
      onKeyDownCapture={blockImplicitEnter}
      onSubmit={(event) => {
        if (tenantMode === "existing" && pickedId === "") {
          event.preventDefault();
          setTenantPickError(true);
          setStep(2);
          return;
        }
        const submitter = (event.nativeEvent as SubmitEvent).submitter;
        if (step !== 8 || !submitReady || !(submitter instanceof HTMLButtonElement) || submitter.dataset.testid !== "submit-lease") {
          event.preventDefault();
          return;
        }
        const rentBad = !amountOk(rent) || !twdRentIsWhole(currency, Number(rent));
        const depositIncomplete = !amountOk(depositMonths);
        const depositStep = !depositIncomplete && !depositMonthsOnHalfStep(Number(depositMonths));
        if (rentBad || depositIncomplete || depositStep) {
          event.preventDefault();
          setRentError(rentBad);
          setDepositError(depositStep ? "step" : depositIncomplete ? "incomplete" : false);
          if (rentBad) setStep(3);
          else setStep(4);
          return;
        }
        if (pending || !claimFormSubmit(submitGuard)) {
          event.preventDefault();
          return;
        }
        if (slowTimer.current) window.clearTimeout(slowTimer.current);
        setSlowSubmit(false);
        slowTimer.current = window.setTimeout(() => setSlowSubmit(true), 8000);
      }}
    >
      <ImplicitSubmitSink />
      <Stepper steps={steps} current={step} />
      {state.error ? (
        <div className="alert bad" data-testid="lease-error" style={{ marginBottom: 12 }}>
          {state.field && (state.error === "errors.required" || state.error === "errors.amount")
            ? t("i_field_incomplete", { field: t(state.field) })
            : errorText(t, state.error)}
        </div>
      ) : null}
      {slowSubmit ? (
        <div className="alert warn" data-testid="lease-submit-slow" style={{ marginBottom: 12 }}>
          {t("i_lease_slow")}{" "}
          <a href="/m/leases" data-testid="lease-slow-link">{t("s_fba85ae")}</a>
        </div>
      ) : null}
      <input type="hidden" name="roomId" value={roomId} />
      <input type="hidden" name="tenantName" value={tenant} />
      <input type="hidden" name="tenantPhone" value={phone} />
      <input type="hidden" name="lineUserId" value={lineId} />
      <input type="hidden" name="tenantMode" value={tenantMode === "existing" ? pickedId : "new"} />
      <input type="hidden" name="rent" value={rent} />
      <input type="hidden" name="months" value={months} />
      <input type="hidden" name="startDate" value={start} />
      <input type="hidden" name="depositMonths" value={depositMonths} />
      <input type="hidden" name="depositReason" value={depositReason} />
      <input type="hidden" name="dueDay" value={dueDay} />
      <input type="hidden" name="splitMethod" value={split} />
      <input type="hidden" name="billTotal" value={bill} />
      <input type="hidden" name="usage" value={usage} />
      <input type="hidden" name="rate" value={rate} />
      <input type="hidden" name="overrideReason" value={reason} />

      <div hidden={step !== 1}>
        <div className="card pad" style={{ maxWidth: 760 }}>
          {rooms.length === 0 ? <div className="alert warn">{t("i_empty")}</div> : null}
          <label className="f">{t("s_8569bc8")}</label>
          <select
            className="inp"
            data-testid="lease-room"
            value={roomId}
            onChange={(event) => chooseRoom(event.currentTarget.value)}
            onBlur={(event) => {
              if (event.currentTarget.value) chooseRoom(event.currentTarget.value);
            }}
          >
            <option value="">{t("i_choose")}</option>
            {rooms.map((item) => (
              <option key={item.id} value={item.id}>
                {item.propertyName} · {item.unitLabel}{item.label ? ` ${item.label}` : ""}
              </option>
            ))}
          </select>
        </div>
      </div>
      <div hidden={step !== 2}>
        <div className="card pad" style={{ maxWidth: 760 }}>
          <label className="radio">
            <input type="radio" data-testid="tenant-mode-new" checked={tenantMode === "new"} onChange={chooseNewTenant} />
            <span>{t("i_new_tenant")}</span>
          </label>
          <label className="radio">
            <input type="radio" data-testid="tenant-mode-existing" checked={tenantMode === "existing"} onChange={chooseExistingTenant} />
            <span>{t("i_existing_tenant")}</span>
          </label>
          {tenantMode === "existing" ? (
            <div className="fg">
              <label className="f" htmlFor="tenant-search">{t("i_tenant_pick")}</label>
              <input
                id="tenant-search"
                className="inp"
                data-testid="tenant-search"
                placeholder={t("i_tenant_search")}
                value={tenantQuery}
                role="combobox"
                aria-expanded={true}
                aria-controls="tenant-options"
                aria-autocomplete="list"
                autoComplete="off"
                onChange={(event) => {
                  setTenantQuery(event.target.value);
                  setTenantContactId("");
                  setTenant("");
                  setPhone("");
                  setTenantPickError(false);
                }}
              />
              <div id="tenant-options" role="listbox" data-testid="tenant-options" style={{ maxHeight: 240, overflow: "auto", marginTop: 8 }}>
                {tenantMatches.map((item) => (
                  <button
                    key={item.id}
                    type="button"
                    role="option"
                    aria-selected={item.id === pickedId}
                    className={`radio${item.id === pickedId ? " on" : ""}`}
                    style={{ width: "100%", textAlign: "left", font: "inherit" }}
                    data-testid="tenant-option"
                    onClick={() => {
                      setTenantContactId(item.id);
                      setTenant(item.name);
                      setPhone(item.phone ?? "");
                      setTenantQuery(item.name);
                      setTenantPickError(false);
                    }}
                  >
                    <span>
                      {item.name}
                      {item.phone ? ` · ${item.phone}` : ""}
                      {item.email ? ` · ${item.email}` : ""}
                    </span>
                  </button>
                ))}
              </div>
              {tenantMatches.length === 0 ? <p className="hint" data-testid="tenant-none">{t("i_tenant_none")}</p> : null}
              {pickedTenant ? <p className="hint" data-testid="tenant-picked">{pickedTenant.name}</p> : null}
              {tenantPickError ? <p className="hint" data-testid="tenant-pick-error">{t("i_step_incomplete", { field: t("i_existing_tenant") })}</p> : null}
            </div>
          ) : (
            <>
              <div className="grid2">
                <div className="fg">
                  <label className="f">{t("s_0c5acea")}</label>
                  <input className="inp" data-testid="tenant-name" placeholder={t("i_ph_tenant")} value={tenant} onChange={(event) => { setTenant(event.target.value); setTenantError(false); }} />
                  {tenantError ? <p className="hint" data-testid="tenant-name-error">{t("i_step_incomplete", { field: t("s_0c5acea") })}</p> : null}
                </div>
                <div className="fg">
                  <label className="f">{t("s_522cf12")}</label>
                  <input className="inp" data-testid="tenant-phone" placeholder={t("i_ph_phone")} value={phone} onChange={(event) => { setPhone(event.target.value); setPhoneError(false); }} />
                  {phoneError ? <p className="hint" data-testid="tenant-phone-error">{t("i_step_incomplete", { field: t("s_522cf12") })}</p> : null}
                </div>
              </div>
              <div className="fg">
                <label className="f">{t("lease_line_id")}</label>
                <input className="inp" data-testid="tenant-line" placeholder={t("lease_ph_line")} value={lineId} onChange={(event) => setLineId(event.target.value)} />
              </div>
              <div className="fg">
                <label className="f">{t("i_email_label")}</label>
                <input
                  className="inp"
                  name="tenantEmail"
                  data-testid="tenant-email"
                  placeholder={t("i_ph_email")}
                  value={tenantEmail}
                  onChange={(event) => noteTenantEmail(event.target.value)}
                  onBlur={(event) => setDuplicateTenant(tenantByEmail(tenants, event.target.value))}
                />
                {duplicateTenant ? (
                  <div className="alert bad" data-testid="tenant-email-exists" style={{ marginTop: 8 }}>
                    <p>{t("i_tenant_exists")}</p>
                    <button className="btn" type="button" data-testid="tenant-use-existing" onClick={() => adoptTenant(duplicateTenant)}>
                      {t("i_tenant_use_existing")}
                    </button>
                  </div>
                ) : null}
              </div>
            </>
          )}
        </div>
      </div>
      <div hidden={step !== 3}>
        <div className="card pad" style={{ maxWidth: 760 }}>
          <div className="grid3">
            <div className="fg">
              <label className="f">{t("s_28aabc4")}</label>
              <input className="inp" type="date" data-testid="start-date" value={start} onChange={(event) => setStart(event.target.value)} />
            </div>
            <div className="fg">
              <label className="f">{t("s_02229b6")}</label>
              <input className="inp" data-testid="term-months" inputMode="numeric" placeholder={t("i_ph_term")} value={months} onChange={(event) => setMonths(event.target.value)} />
            </div>
            <div className="fg">
              <label className="f">{t("i_base_rent")}</label>
              <input className="inp" data-testid="rent" inputMode="decimal" placeholder={t("i_ph_rent")} value={rent} onChange={(event) => { setRent(event.target.value); setRentError(false); }} />
              {rentError ? <p className="hint" data-testid="rent-error">{t("i_step_incomplete", { field: t("i_base_rent") })}</p> : null}
              <div className="hint">{t("s_759b7ba")}</div>
              {room ? <div className="hint">{t("i_base_hint", { amount: money(room.baseRentMinor / 100, currency, locale) })}</div> : null}
            </div>
          </div>
        </div>
      </div>
      <div hidden={step !== 4}>
        <div className="card pad" style={{ maxWidth: 760 }}>
          <div className="fg">
            <label className="f">{t("s_8ed103e")}</label>
            <input className="inp" data-testid="deposit-months" inputMode="decimal" placeholder={t("i_ph_dep")} value={depositMonths} onChange={(event) => { setDepositMonths(event.target.value); setDepositError(false); }} />
            {depositError ? (
              <p className="hint" data-testid="deposit-error">
                {depositError === "step" ? t("i_deposit_half_step") : t("i_step_incomplete", { field: t("s_8ed103e") })}
              </p>
            ) : null}
          </div>
          {depositOver ? (
            <div className="alert warn" data-testid="deposit-alert">
              <div>{t("lease_deposit_over", { months: depositMonths, cap: 2 })}</div>
              <label className="f" style={{ marginTop: 8 }}>{t("lease_deposit_reason")}</label>
              <textarea
                className="inp"
                data-testid="deposit-reason"
                placeholder={t("lease_ph_deposit_reason")}
                value={depositReason}
                onChange={(event) => setDepositReason(event.target.value)}
              />
            </div>
          ) : null}
        </div>
      </div>
      <div hidden={step !== 5}>
        <div className="card pad" style={{ maxWidth: 760 }}>
          <div className="fg">
            <label className="f">{t("s_aa47e23")}</label>
            <input className="inp" data-testid="due-day" inputMode="numeric" placeholder={t("i_ph_due")} value={dueDay} onChange={(event) => { setDueDay(event.target.value); setDueError(false); }} />
            {dueError ? <p className="hint" data-testid="due-error">{t("i_step_incomplete", { field: t("s_aa47e23") })}</p> : null}
          </div>
          <p className="hint">{t("s_c6a6031")}</p>
        </div>
      </div>
      <div hidden={step !== 6}>
        <div className="card pad" style={{ maxWidth: 760 }}>
          <div className="fg">
            <label className="f">{t("i_split")}</label>
            <select className="inp" data-testid="split-method" value={split} onChange={(event) => setSplit(event.target.value)}>
              <option value="">{t("i_choose")}</option>
              <option value="even">{t("s_ecf0e25")}</option>
              <option value="days_occupied">{t("s_c8e758d")}</option>
              <option value="sub_meter">{t("s_9f8b19c")}</option>
            </select>
          </div>
          <div className="grid3">
            <div className="fg">
              <label className="f">{t("i_bill_total")}</label>
              <input className="inp" data-testid="bill-total" inputMode="decimal" placeholder={t("i_ph_bill")} value={bill} onChange={(event) => { setBill(event.target.value); setBillError(false); }} />
              {billError ? <p className="hint" data-testid="bill-error">{t("i_step_incomplete", { field: t("i_bill_total") })}</p> : null}
            </div>
            <div className="fg">
              <label className="f">{t("i_usage")}</label>
              <input className="inp" data-testid="usage" inputMode="decimal" placeholder={t("i_ph_kwh")} value={usage} onChange={(event) => { setUsage(event.target.value); setUsageError(false); }} />
              {usageError ? <p className="hint" data-testid="usage-error">{t("i_step_incomplete", { field: t("i_usage") })}</p> : null}
            </div>
            <div className="fg">
              <label className="f">{t("i_rate")}</label>
              <input className="inp" data-testid="rate" inputMode="decimal" placeholder={t("i_ph_rate")} value={rate} onChange={(event) => { setRate(event.target.value); setRateError(false); }} />
              {rateError ? <p className="hint" data-testid="rate-error">{t("i_step_incomplete", { field: t("i_rate") })}</p> : null}
            </div>
          </div>
          {over ? (
            <div className="alert bad" data-testid="cap-alert">
              <div>
                <div>{t("s_ab3ec53")}</div>
                <div>{t("i_cap_over", { avg: average?.toFixed(2) ?? "", rate: rateN.toFixed(2) })}</div>
                <div className="small">{t("s_c6a6031")}</div>
                <label className="f" style={{ marginTop: 8 }}>{t("s_7cb89e9")}</label>
                <textarea className="inp" data-testid="override-reason" placeholder={t("i_ph_reason")} value={reason} onChange={(event) => setReason(event.target.value)} />
              </div>
            </div>
          ) : average === null && bill === "" ? (
            <p className="hint">{t("s_7afe0af")}</p>
          ) : null}
          {preview && split ? (
            <div style={{ marginTop: 12 }}>
              <h3>{t("i_preview_cap")}</h3>
              <p data-testid="charged-total">
                {t("i_charged_total", {
                  amount: money(preview.charged, currency, locale),
                  bill: money(preview.bill, currency, locale),
                })}
              </p>
              <table className="t">
                <tbody>
                  {preview.shares.map((share) => (
                    <tr key={share.label}>
                      <td>{share.label}</td>
                      <td className="num">{money(share.amount, currency, locale)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : null}
        </div>
      </div>
      <div hidden={step !== 7}>
        <div
          className="card pad"
          style={{ maxWidth: 760 }}
          data-testid="lease-template"
          data-lang={bilingual ? "bilingual" : templateLang}
          data-bilingual={bilingual ? "true" : "false"}
        >
          <p>{t("i_template_note")}</p>
          <label className="f">{t("i_template_lang")}</label>
          <label className={`radio${templateLang === "zh-TW" && !bilingual ? " on" : ""}`}>
            <input
              type="radio"
              name="templateLang"
              data-testid="template-lang-zh"
              checked={templateLang === "zh-TW" && !bilingual}
              onChange={() => {
                setTemplateLang("zh-TW");
                setBilingual(false);
              }}
            />
            <span>{t("i_template_zh")}</span>
          </label>
          <label className={`radio${templateLang === "en" && !bilingual ? " on" : ""}`}>
            <input
              type="radio"
              data-testid="template-lang-en"
              checked={templateLang === "en" && !bilingual}
              onChange={() => {
                setTemplateLang("en");
                setBilingual(false);
              }}
            />
            <span>{t("i_template_en")}</span>
          </label>
          <label className={`radio${bilingual ? " on" : ""}`}>
            <input
              type="radio"
              data-testid="template-bilingual"
              checked={bilingual}
              onChange={() => setBilingual(true)}
            />
            <span>{t("s_ba81c1a")}</span>
          </label>
        </div>
      </div>
      <div hidden={step !== 8}>
        <div className="card pad" style={{ maxWidth: 760 }}>
          <p>{t("i_confirm_lease")}</p>
          <table className="t">
            <tbody>
              {summary ? (
                <tr>
                  <td>{t("i_space")}</td>
                  <td data-testid="lease-confirm-space">{confirmSpace(summary)}</td>
                </tr>
              ) : null}
              <tr>
                <td>{t("s_74f19b0")}</td>
                <td data-testid="lease-confirm-tenant">{tenant}</td>
              </tr>
              <tr>
                <td>{t("i_rent_label")}</td>
                <td data-testid="lease-confirm-rent">{money(Number(rent), summary?.currency ?? currency, locale)}</td>
              </tr>
              <tr>
                <td>{t("i_deposit_label")}</td>
                <td data-testid="lease-confirm-deposit">{confirmDeposit(depositMonths, rent, summary?.currency ?? currency, locale, money)}</td>
              </tr>
              <tr>
                <td>{t("i_rate")}</td>
                <td>{rate}</td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>
      <div className="row" style={{ marginTop: 16, maxWidth: 760 }}>
        {step > 1 ? (
          <button className="btn" type="button" onClick={goBack}>
            ← {t("s_5bf6faa")}
          </button>
        ) : null}
        <span className="sp" />
        {/* A new node on the last step. Updating the next button in place turns this click into a submit. */}
        {step < 8 ? (
          <button key="wizard-next" className="btn pri" type="button" data-testid="wizard-next" disabled={blocked || (step === 1 && !roomId)} onClick={goNext}>
            {t("s_9cff86c")} →
          </button>
        ) : (
          <button key="submit-lease" className="btn pri" type="submit" data-testid="submit-lease" disabled={blocked || pending || !submitReady} aria-busy={pending ? true : undefined}>
            {t("s_79b6c1d")}
          </button>
        )}
      </div>
    </form>
  );
}
