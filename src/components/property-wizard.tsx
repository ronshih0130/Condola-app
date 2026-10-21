"use client";

import { useActionState, useMemo, useState } from "react";
import { errorText } from "@/i18n/errors";
import { actionCreateProperty } from "@/server/actions";
import { useLocale, useT } from "./locale";
import { Stepper } from "./ui";

const ROOM_TYPES = ["suite", "shared_bath", "studio", "other"] as const;
const TYPE_KEY: Record<string, string> = {
  suite: "i_suite",
  shared_bath: "i_shared",
  studio: "i_studio",
  other: "i_other_room",
};

function money(major: number, currency: string, locale: string) {
  return new Intl.NumberFormat(locale === "zh-TW" ? "zh-Hant-TW" : "en-US", {
    style: "currency",
    currency,
    maximumFractionDigits: currency === "TWD" ? 0 : 2,
  }).format(major);
}

export function PropertyWizard({ owners }: { owners: { id: string; name: string }[] }) {
  const t = useT();
  const locale = useLocale();
  const [state, formAction] = useActionState(actionCreateProperty, { error: "" });
  const steps = [t("s_634053c"), t("s_d2c40b1"), t("s_a757163"), t("s_a68e8dc")];
  const [step, setStep] = useState(1);
  const [ownerMode, setOwnerMode] = useState("");
  const [existingId, setExistingId] = useState("");
  const [rentalMode, setRentalMode] = useState("");
  const [currency, setCurrency] = useState("TWD");
  const [split, setSplit] = useState("");
  const [bill, setBill] = useState("");
  const [usage, setUsage] = useState("");
  const [rate, setRate] = useState("");
  const [reason, setReason] = useState("");
  const [labels, setLabels] = useState(["", "", ""]);
  const [rents, setRents] = useState(["", "", ""]);
  const [types, setTypes] = useState(["", "", ""]);

  const billN = Number(bill);
  const usageN = Number(usage);
  const rateN = Number(rate);
  const average = usageN > 0 && bill !== "" ? billN / usageN : null;
  const over = average !== null && rate !== "" && rateN > average + 1e-9;
  const blocked = step >= 4 && over && reason.trim() === "";
  const roomCount = rentalMode === "whole_unit" ? 1 : 3;

  const preview = useMemo(() => {
    if (!(usageN > 0) || rate === "") return null;
    const charged = usageN * rateN;
    const rooms = labels.map((label, index) => label.trim() || String(index + 1)).slice(0, roomCount);
    const share = rooms.length ? charged / rooms.length : charged;
    return { charged, rooms, share, bill: billN };
  }, [usageN, rate, rateN, labels, roomCount, billN]);

  return (
    <form action={formAction}>
      <Stepper steps={steps} current={step} />
      {state.error ? (
        <div className="alert bad" data-testid="property-error" style={{ marginBottom: 12 }}>
          {errorText(t, state.error)}
        </div>
      ) : null}
      <div hidden={step !== 1}>
        <div className="card pad" style={{ maxWidth: 760 }}>
          <div className="fg">
            <label className="f">{t("i_property_name")}</label>
            <input className="inp" name="name" data-testid="property-name" placeholder={t("i_ph_street")} defaultValue="" />
          </div>
          <div className="grid2">
            <div className="fg">
              <label className="f">{t("i_city")}</label>
              <input className="inp" name="city" data-testid="property-city" placeholder={t("i_ph_city")} defaultValue="" />
            </div>
            <div className="fg">
              <label className="f">{t("i_district")}</label>
              <input className="inp" name="district" data-testid="property-district" placeholder={t("i_ph_district")} defaultValue="" />
            </div>
          </div>
          <div className="grid2">
            <div className="fg">
              <label className="f">{t("i_street")}</label>
              <input className="inp" name="street" data-testid="property-street" placeholder={t("i_ph_street")} defaultValue="" />
            </div>
            <div className="fg">
              <label className="f">{t("i_number")}</label>
              <input className="inp" name="number" placeholder={t("i_ph_no")} defaultValue="" />
            </div>
          </div>
          <div className="fg">
            <label className="f">{t("i_currency_label")}</label>
            <select className="inp" name="currency" value={currency} onChange={(event) => setCurrency(event.target.value)}>
              <option value="TWD">TWD</option>
              <option value="USD">USD</option>
            </select>
          </div>
          <input type="hidden" name="ownerMode" value={ownerMode === "new" ? "new" : existingId} />
          <label className="radio">
            <input type="radio" checked={ownerMode === "new"} onChange={() => setOwnerMode("new")} />
            <span>{t("i_new_owner")}</span>
          </label>
          <label className="radio">
            <input type="radio" checked={ownerMode === "existing"} onChange={() => setOwnerMode("existing")} />
            <span>{t("i_existing_owner")}</span>
          </label>
          {ownerMode === "existing" ? (
            <select className="inp" value={existingId} onChange={(event) => setExistingId(event.target.value)}>
              <option value="">{t("i_choose")}</option>
              {owners.map((owner) => (
                <option key={owner.id} value={owner.id}>
                  {owner.name}
                </option>
              ))}
            </select>
          ) : null}
          <div className="grid2" style={{ marginTop: 12 }}>
            <div className="fg">
              <label className="f">{t("s_0c5acea")}</label>
              <input className="inp" name="ownerName" data-testid="owner-name" placeholder={t("i_ph_owner")} defaultValue="" />
            </div>
            <div className="fg">
              <label className="f">{t("i_phone_label")}</label>
              <input className="inp" name="ownerPhone" data-testid="owner-phone" placeholder={t("i_ph_phone")} defaultValue="" />
            </div>
          </div>
          <div className="fg">
            <label className="f">{t("i_email_label")}</label>
            <input className="inp" name="ownerEmail" placeholder={t("i_ph_email")} defaultValue="" />
          </div>
          <label className="small">
            <input type="checkbox" name="canViewTenantPhone" /> {t("i_owner_phone_vis")}
          </label>
        </div>
      </div>
      <div hidden={step !== 2}>
        <div className="card pad" style={{ maxWidth: 760 }}>
          <label className="radio">
            <input type="radio" name="rentalMode" value="by_room" checked={rentalMode === "by_room"} onChange={() => setRentalMode("by_room")} />
            <span>{t("i_by_room")}</span>
          </label>
          <label className="radio">
            <input type="radio" name="rentalMode" value="whole_unit" checked={rentalMode === "whole_unit"} onChange={() => setRentalMode("whole_unit")} />
            <span>{t("i_whole_unit")}</span>
          </label>
        </div>
      </div>
      <div hidden={step !== 3}>
        <div className="card pad" style={{ maxWidth: 760 }}>
          {rentalMode === "whole_unit" ? null : <p className="hint">{t("i_rooms_hint")}</p>}
          <div className="grid2">
            <div className="fg">
              <label className="f">{t("i_unit_label")}</label>
              <input className="inp" name="unitLabel" data-testid="unit-label" placeholder={t("i_ph_unit")} defaultValue="" />
            </div>
            <div className="fg">
              <label className="f">{t("i_floor")}</label>
              <input className="inp" name="floor" placeholder={t("i_ph_floor")} defaultValue="" />
            </div>
          </div>
          {rentalMode === "whole_unit" ? null : [0, 1, 2].map((index) => (
            <div className="grid3" key={index}>
              <div className="fg">
                <label className="f">{t("s_8569bc8")}</label>
                <input
                  className="inp"
                  name={`room${index}label`}
                  data-testid={`room-${index}-label`}
                  placeholder={t(index === 0 ? "i_ph_room_a" : index === 1 ? "i_ph_room_b" : "i_ph_room_c")}
                  value={labels[index]}
                  onChange={(event) => {
                    const next = [...labels];
                    next[index] = event.target.value;
                    setLabels(next);
                  }}
                />
              </div>
              <div className="fg">
                <label className="f">{t("i_room_type")}</label>
                <select
                  className="inp"
                  name={`room${index}type`}
                  data-testid={`room-${index}-type`}
                  value={types[index]}
                  onChange={(event) => {
                    const next = [...types];
                    next[index] = event.target.value;
                    setTypes(next);
                  }}
                >
                  <option value="">{t("i_choose")}</option>
                  {ROOM_TYPES.map((type) => (
                    <option key={type} value={type}>
                      {t(TYPE_KEY[type])}
                    </option>
                  ))}
                </select>
              </div>
              <div className="fg">
                <label className="f">{t("i_base_rent")}</label>
                <input
                  className="inp"
                  name={`room${index}rent`}
                  data-testid={`room-${index}-rent`}
                  inputMode="decimal"
                  placeholder={t("i_ph_rent")}
                  value={rents[index]}
                  onChange={(event) => {
                    const next = [...rents];
                    next[index] = event.target.value;
                    setRents(next);
                  }}
                />
              </div>
            </div>
          ))}
        </div>
      </div>
      <div hidden={step !== 4}>
        <div className="card pad" style={{ maxWidth: 760 }}>
          <div className="fg">
            <label className="f">{t("i_split")}</label>
            <select className="inp" name="splitPreview" value={split} onChange={(event) => setSplit(event.target.value)}>
              <option value="">{t("i_choose")}</option>
              <option value="even">{t("s_ecf0e25")}</option>
              <option value="days">{t("s_c8e758d")}</option>
              <option value="sub">{t("s_9f8b19c")}</option>
            </select>
          </div>
          <div className="grid3">
            <div className="fg">
              <label className="f">{t("i_bill_total")}</label>
              <input className="inp" inputMode="decimal" placeholder={t("i_ph_bill")} value={bill} onChange={(event) => setBill(event.target.value)} />
            </div>
            <div className="fg">
              <label className="f">{t("i_usage")}</label>
              <input className="inp" inputMode="decimal" placeholder={t("i_ph_kwh")} value={usage} onChange={(event) => setUsage(event.target.value)} />
            </div>
            <div className="fg">
              <label className="f">{t("i_rate")}</label>
              <input className="inp" inputMode="decimal" placeholder={t("i_ph_rate")} value={rate} onChange={(event) => setRate(event.target.value)} />
            </div>
          </div>
          {over ? (
            <div className="alert bad" data-testid="cap-alert">
              <div>
                <div>{t("s_ab3ec53")}</div>
                <div>{t("i_cap_over", { avg: average?.toFixed(2) ?? "", rate: rateN.toFixed(2) })}</div>
                <div className="small">{t("s_c6a6031")}</div>
                <textarea className="inp" style={{ marginTop: 8 }} placeholder={t("i_ph_reason")} value={reason} onChange={(event) => setReason(event.target.value)} />
              </div>
            </div>
          ) : null}
          {preview && split ? (
            <div style={{ marginTop: 12 }}>
              <h3>{t("i_preview_cap")}</h3>
              <p data-testid="charged-total">{t("i_charged_total", { amount: money(preview.charged, currency, locale), bill: money(preview.bill || 0, currency, locale) })}</p>
              <table className="t">
                <tbody>
                  {preview.rooms.map((label) => (
                    <tr key={label}>
                      <td>{label}</td>
                      <td className="num">{money(preview.share, currency, locale)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : null}
        </div>
      </div>
      <div className="row" style={{ marginTop: 16, maxWidth: 760 }}>
        {step > 1 ? (
          <button className="btn" type="button" onClick={() => setStep(step - 1)}>
            ← {t("s_5bf6faa")}
          </button>
        ) : null}
        <span className="sp" />
        {step < 4 ? (
          <button className="btn pri" type="button" data-testid="wizard-next" disabled={blocked || (step === 2 && !rentalMode) || (step === 1 && !ownerMode)} onClick={() => setStep(step + 1)}>
            {t("s_9cff86c")} →
          </button>
        ) : (
          <button className="btn pri" type="submit" data-testid="submit-property" disabled={blocked}>
            {t("s_aed91da")}
          </button>
        )}
      </div>
    </form>
  );
}
