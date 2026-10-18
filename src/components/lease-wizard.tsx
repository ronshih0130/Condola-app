"use client";

import { useMemo, useState } from "react";
import { actionCreateLease } from "@/server/actions";
import type { RoomOption } from "@/server/queries";
import { useLocale, useT } from "./locale";
import { Stepper } from "./ui";

function money(major: number, currency: string, locale: string) {
  if (!Number.isFinite(major)) return "";
  return new Intl.NumberFormat(locale === "zh-TW" ? "zh-Hant-TW" : "en-US", {
    style: "currency",
    currency,
    maximumFractionDigits: currency === "TWD" ? 0 : 2,
  }).format(major);
}

export function LeaseWizard({ rooms, firmLocale }: { rooms: RoomOption[]; firmLocale: "zh-TW" | "en" }) {
  const t = useT();
  const locale = useLocale();
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
  const [tenant, setTenant] = useState("");
  const [phone, setPhone] = useState("");
  const [rent, setRent] = useState("");
  const [months, setMonths] = useState("");
  const [start, setStart] = useState("");
  const [depositMonths, setDepositMonths] = useState("");
  const [dueDay, setDueDay] = useState("");
  const [split, setSplit] = useState("");
  const [bill, setBill] = useState("");
  const [usage, setUsage] = useState("");
  const [rate, setRate] = useState("");
  const [reason, setReason] = useState("");
  const [templateLang, setTemplateLang] = useState<"zh-TW" | "en">(firmLocale === "en" ? "en" : "zh-TW");
  const [bilingual, setBilingual] = useState(false);

  const room = rooms.find((item) => item.id === roomId);
  const currency = room?.currency ?? "TWD";
  const billN = Number(bill);
  const usageN = Number(usage);
  const rateN = Number(rate);
  const average = usageN > 0 && bill !== "" ? billN / usageN : null;
  const over = average !== null && rate !== "" && rateN > average + 1e-9;
  const blocked = step >= 6 && (split === "" || (over && reason.trim() === ""));

  const preview = useMemo(() => {
    if (!room || !(usageN > 0) || rate === "") return null;
    const charged = usageN * rateN;
    const count = Math.max(room.unitRooms.length, 1);
    return {
      charged,
      bill: Number.isFinite(billN) ? billN : 0,
      shares: room.unitRooms.map((item) => ({ label: item.label, amount: charged / count })),
    };
  }, [room, usageN, rate, rateN, billN]);

  return (
    <form action={actionCreateLease}>
      <Stepper steps={steps} current={step} />
      <input type="hidden" name="roomId" value={roomId} />
      <input type="hidden" name="tenantName" value={tenant} />
      <input type="hidden" name="tenantPhone" value={phone} />
      <input type="hidden" name="rent" value={rent} />
      <input type="hidden" name="months" value={months} />
      <input type="hidden" name="startDate" value={start} />
      <input type="hidden" name="depositMonths" value={depositMonths} />
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
          <select className="inp" data-testid="lease-room" value={roomId} onChange={(event) => setRoomId(event.target.value)}>
            <option value="">{t("i_choose")}</option>
            {rooms.map((item) => (
              <option key={item.id} value={item.id}>
                {item.propertyName} · {item.unitLabel} {item.label}
              </option>
            ))}
          </select>
        </div>
      </div>
      <div hidden={step !== 2}>
        <div className="card pad" style={{ maxWidth: 760 }}>
          <div className="grid2">
            <div className="fg">
              <label className="f">{t("s_0c5acea")}</label>
              <input className="inp" data-testid="tenant-name" placeholder={t("i_ph_tenant")} value={tenant} onChange={(event) => setTenant(event.target.value)} />
            </div>
            <div className="fg">
              <label className="f">{t("s_522cf12")}</label>
              <input className="inp" data-testid="tenant-phone" placeholder={t("i_ph_phone")} value={phone} onChange={(event) => setPhone(event.target.value)} />
            </div>
          </div>
          <div className="fg">
            <label className="f">{t("i_email_label")}</label>
            <input className="inp" name="tenantEmail" placeholder={t("i_ph_email")} defaultValue="" />
          </div>
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
              <input className="inp" data-testid="rent" inputMode="decimal" placeholder={t("i_ph_rent")} value={rent} onChange={(event) => setRent(event.target.value)} />
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
            <input className="inp" data-testid="deposit-months" inputMode="decimal" placeholder={t("i_ph_dep")} value={depositMonths} onChange={(event) => setDepositMonths(event.target.value)} />
          </div>
          {Number(depositMonths) > 2 ? <div className="alert warn">{t("i_deposit_over", { months: depositMonths, cap: 2 })}</div> : null}
        </div>
      </div>
      <div hidden={step !== 5}>
        <div className="card pad" style={{ maxWidth: 760 }}>
          <div className="fg">
            <label className="f">{t("s_aa47e23")}</label>
            <input className="inp" data-testid="due-day" inputMode="numeric" placeholder={t("i_ph_due")} value={dueDay} onChange={(event) => setDueDay(event.target.value)} />
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
              <input className="inp" data-testid="bill-total" inputMode="decimal" placeholder={t("i_ph_bill")} value={bill} onChange={(event) => setBill(event.target.value)} />
            </div>
            <div className="fg">
              <label className="f">{t("i_usage")}</label>
              <input className="inp" data-testid="usage" inputMode="decimal" placeholder={t("i_ph_kwh")} value={usage} onChange={(event) => setUsage(event.target.value)} />
            </div>
            <div className="fg">
              <label className="f">{t("i_rate")}</label>
              <input className="inp" data-testid="rate" inputMode="decimal" placeholder={t("i_ph_rate")} value={rate} onChange={(event) => setRate(event.target.value)} />
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
              <tr>
                <td>{t("s_74f19b0")}</td>
                <td>{tenant}</td>
              </tr>
              <tr>
                <td>{t("i_rent_label")}</td>
                <td>{rent}</td>
              </tr>
              <tr>
                <td>{t("i_deposit_label")}</td>
                <td>{depositMonths}</td>
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
          <button className="btn" type="button" onClick={() => setStep(step - 1)}>
            ← {t("s_5bf6faa")}
          </button>
        ) : null}
        <span className="sp" />
        {step < 8 ? (
          <button className="btn pri" type="button" data-testid="wizard-next" disabled={blocked || (step === 1 && !roomId)} onClick={() => setStep(step + 1)}>
            {t("s_9cff86c")} →
          </button>
        ) : (
          <button className="btn pri" type="submit" data-testid="submit-lease" disabled={blocked}>
            {t("s_79b6c1d")}
          </button>
        )}
      </div>
    </form>
  );
}
