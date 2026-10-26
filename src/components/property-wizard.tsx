"use client";

import { useActionState, useEffect, useMemo, useRef, useState } from "react";
import { useMountSubmitToken } from "./submit-token";
import { exampleRoomCharges, exampleSamplesForRooms } from "@/electric-example";
import { errorText } from "@/i18n/errors";
import { phoneInputInvalid } from "@/server/lease-rules";
import { actionCreateProperty } from "@/server/actions";
import { PhoneField } from "./phone-field";
import { useLocale, useT } from "./locale";
import { ImplicitSubmitSink, blockImplicitEnter } from "./form-enter";
import { Stepper } from "./ui";

const ROOM_TYPES = ["whole_home", "studio", "suite", "shared_bath"] as const;
const TYPE_KEY: Record<string, string> = {
  whole_home: "i_whole_home",
  studio: "i_studio",
  suite: "i_room_split",
  shared_bath: "i_shared",
};

type RoomDraft = { label: string; type: string; rent: string; opening: string };
type UnitDraft = { floor: string; door: string; rooms: RoomDraft[] };

function money(major: number, currency: string, locale: string) {
  const code = currency.trim().toUpperCase();
  if (code === "TWD") {
    const formatted = new Intl.NumberFormat(locale === "zh-TW" ? "zh-Hant-TW" : "en-US", {
      maximumFractionDigits: 0,
      minimumFractionDigits: 0,
    }).format(Math.round(Math.abs(major)));
    return `NT$${formatted}`;
  }
  return new Intl.NumberFormat(locale === "zh-TW" ? "zh-Hant-TW" : "en-US", {
    style: "currency",
    currency: code,
    maximumFractionDigits: 2,
  }).format(major);
}

function blankRoom(room: RoomDraft) {
  return room.label.trim() === "" && room.rent.trim() === "";
}

function emptyRoom(): RoomDraft {
  return { label: "", type: "", rent: "", opening: "" };
}

function stepOf(field: string) {
  if (field === "i_unit_label" || field === "i_floor" || field === "s_8569bc8" || field === "i_room_type") return 3;
  return 1;
}

function roomNeedsType(room: RoomDraft) {
  return (room.label.trim() !== "" || room.rent.trim() !== "") && room.type === "";
}

export function PropertyWizard({
  owners,
  currency = "TWD",
  callingCode = "+886",
}: {
  owners: { id: string; name: string }[];
  currency?: "TWD" | "USD";
  callingCode?: string;
}) {
  const t = useT();
  const locale = useLocale();
  const [state, formAction] = useActionState(actionCreateProperty, { error: "" });
  const steps = [t("s_634053c"), t("s_d2c40b1"), t("s_a757163"), t("s_a68e8dc")];
  const [step, setStep] = useState(1);
  const [ownerMode, setOwnerMode] = useState("");
  const [existingId, setExistingId] = useState("");
  const [rentalMode, setRentalMode] = useState("");
  const [split, setSplit] = useState("");
  const [rate, setRate] = useState("");
  const [name, setName] = useState("");
  const [city, setCity] = useState("");
  const [district, setDistrict] = useState("");
  const [street, setStreet] = useState("");
  const [number, setNumber] = useState("");
  const [ownerName, setOwnerName] = useState("");
  const [ownerPhone, setOwnerPhone] = useState("");
  const [phoneCode, setPhoneCode] = useState(callingCode);
  const [ownerEmail, setOwnerEmail] = useState("");
  const [unitLabel, setUnitLabel] = useState("");
  const [floor, setFloor] = useState("");
  const [door, setDoor] = useState("");
  const [rooms, setRooms] = useState<RoomDraft[]>([emptyRoom()]);
  const [extras, setExtras] = useState<UnitDraft[]>([]);
  const [fieldError, setFieldError] = useState("");
  const [submitReady, setSubmitReady] = useState(true);
  const [saving, setSaving] = useState(false);
  const armSubmit = useRef<number | null>(null);
  const submitToken = useMountSubmitToken();
  const blocked = false;

  useEffect(() => {
    if (!state.error) return;
    setSaving(false);
    setSubmitReady(true);
    if (state.step != null) setStep(state.step);
    else if (state.field === "i_room_type") setStep(3);
  }, [state.error, state.field, state.step]);

  const filledRooms = rooms.filter((room) => !blankRoom(room));
  const rateN = Number(rate);
  const wholeHome = rooms.some((room) => room.type === "whole_home");

  const wholeUnit = rentalMode === "whole_unit";
  const preview = useMemo(() => {
    const pricedRate = rateN > 0 ? rateN : 6;
    const labels = wholeUnit
      ? [rooms[0]?.label.trim() || "整層"]
      : filledRooms.length
        ? filledRooms.map((room, index) => room.label.trim() || String.fromCharCode(65 + index))
        : ["A", "B"];
    const samples = exampleSamplesForRooms(labels.length);
    const priced = exampleRoomCharges(pricedRate, samples, currency === "TWD");
    if (!priced) return [];
    return labels.map((label, index) => ({
      label,
      kwh: priced.kwh[index],
      amount: priced.lines[index],
    }));
  }, [rateN, filledRooms, currency, wholeUnit, rooms]);

  function gap(throughStep: number) {
    if (!name.trim()) return "i_property_name";
    if (!city.trim()) return "i_city";
    if (!street.trim() && !number.trim()) return "i_address";
    if (phoneInputInvalid(ownerPhone, phoneCode)) return "i_phone_mobile";
    if (ownerMode === "new" && !ownerName.trim()) return "s_0c5acea";
    if (throughStep >= 3 && !floor.trim()) return "i_floor";
    if (throughStep >= 3 && rentalMode === "whole_unit" && !rooms[0]?.label.trim()) return "s_8569bc8";
    if (throughStep >= 3 && rentalMode === "by_room") {
      if (wholeHome && filledRooms.length !== 1) return "s_8569bc8";
      if (!filledRooms.length || filledRooms.some((room) => !room.label.trim())) return "s_8569bc8";
      if (filledRooms.some((room) => !room.type) || extras.some((unit) => unit.rooms.some(roomNeedsType))) return "i_room_type";
    }
    return "";
  }

  function goNext() {
    const missing = step === 1 ? gap(1) : step === 3 ? gap(3) : "";
    if (missing) {
      setFieldError(missing);
      return;
    }
    setFieldError("");
    const next = step + 1;
    if (next === 4) {
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

  const serverField = state.field || (state.error === "errors.phone" ? "i_phone_mobile" : "");
  const namedField = fieldError || (serverField && (state.error === "errors.required" || state.error === "errors.amount" || state.error === "errors.phone") ? serverField : "");

  function invalidProps(field: string) {
    return namedField === field
      ? ({ "aria-invalid": true as const, "data-field": field })
      : ({ "data-field": field });
  }

  function chooseWholeUnit() {
    setRentalMode("whole_unit");
    setRooms((current) => [{ ...emptyRoom(), rent: current[0]?.rent ?? "", label: "整層", type: "whole_home" }]);
    setExtras([]);
    setFieldError("");
  }

  function updateRoom(index: number, patch: Partial<RoomDraft>) {
    if (patch.type === "whole_home") {
      setRooms([{ ...rooms[index], ...patch }]);
      setFieldError("");
      return;
    }
    setRooms(rooms.map((room, roomIndex) => (roomIndex === index ? { ...room, ...patch } : room)));
    setFieldError("");
  }

  function fieldClass(key: string) {
    return `fg${namedField === key ? " err" : ""}`;
  }

  return (
    <form
      action={formAction}
      noValidate
      onKeyDownCapture={blockImplicitEnter}
      onSubmit={(event) => {
        const submitter = (event.nativeEvent as SubmitEvent).submitter;
        if (!(submitter instanceof HTMLButtonElement) || submitter.dataset.testid !== "submit-property" || !submitReady || saving || !submitToken) {
          event.preventDefault();
          return;
        }
        const missing = gap(4);
        if (missing) {
          event.preventDefault();
          setSaving(false);
          setFieldError(missing);
          setStep(stepOf(missing));
          return;
        }
        setSaving(true);
        setSubmitReady(false);
      }}
    >
      <input type="hidden" name="submitToken" value={submitToken} />
      <input type="hidden" name="currency" value={currency} />
      <ImplicitSubmitSink />
      <Stepper steps={steps} current={step} errorStep={namedField ? stepOf(namedField) : undefined} />
      <div hidden={step !== 1}>
        <div className="card pad" style={{ maxWidth: 760 }}>
          <h3>{t("i_sec_property")}</h3>
          <div className={fieldClass("i_property_name")}>
            <label className="f">{t("i_property_name")}</label>
            <input className="inp" name="name" data-testid="property-name" placeholder={t("i_ph_street")} value={name} {...invalidProps("i_property_name")} onChange={(event) => { setName(event.target.value); setFieldError(""); }} />
            {namedField === "i_property_name" ? <p className="errmsg">{t("i_step_incomplete", { field: t("i_property_name") })}</p> : null}
          </div>
          <div className="grid2">
            <div className={fieldClass("i_city")}>
              <label className="f">{t("i_city")}</label>
              <input className="inp" name="city" data-testid="property-city" placeholder={t("i_ph_city")} value={city} {...invalidProps("i_city")} onChange={(event) => { setCity(event.target.value); setFieldError(""); }} />
              {namedField === "i_city" ? <p className="errmsg">{t("i_step_incomplete", { field: t("i_city") })}</p> : null}
            </div>
            <div className="fg">
              <label className="f">{t("i_district")}</label>
              <input className="inp" name="district" data-testid="property-district" placeholder={t("i_ph_district")} value={district} onChange={(event) => setDistrict(event.target.value)} />
            </div>
          </div>
          <div className="grid2">
            <div className={fieldClass("i_address")}>
              <label className="f">{t("i_street")}</label>
              <input className="inp" name="street" data-testid="property-street" placeholder={t("i_ph_street")} value={street} {...invalidProps("i_address")} onChange={(event) => { setStreet(event.target.value); setFieldError(""); }} />
              {namedField === "i_address" ? <p className="errmsg" data-testid="property-address-error">{t("i_step_incomplete", { field: t("i_address") })}</p> : null}
            </div>
            <div className="fg">
              <label className="f">{t("i_number")}</label>
              <input className="inp" name="number" placeholder={t("i_ph_no")} value={number} onChange={(event) => { setNumber(event.target.value); setFieldError(""); }} />
            </div>
          </div>
          <input type="hidden" name="ownerMode" value={ownerMode === "new" ? "new" : existingId} />
          <h3>{t("i_owner")}</h3>
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
            <div className={fieldClass("s_0c5acea")}>
              <label className="f">{t("s_0c5acea")}</label>
              <input className="inp" name="ownerName" data-testid="owner-name" placeholder={t("i_ph_owner")} value={ownerName} onChange={(event) => { setOwnerName(event.target.value); setFieldError(""); }} />
              {namedField === "s_0c5acea" ? <p className="errmsg">{t("i_step_incomplete", { field: t("s_0c5acea") })}</p> : null}
            </div>
            <div className={fieldClass("i_phone_mobile")}>
              <label className="f">{t("i_phone_label")}</label>
              <PhoneField
                name="ownerPhone"
                testId="owner-phone"
                value={ownerPhone}
                callingCode={phoneCode}
                onChange={(value) => { setOwnerPhone(value); setFieldError(""); }}
                onCallingCode={setPhoneCode}
                invalid={namedField === "i_phone_mobile"}
              />
              {namedField === "i_phone_mobile" ? <p className="errmsg" data-testid="owner-phone-error">{t("i_phone_mobile")}</p> : null}
            </div>
          </div>
          <div className="fg">
            <label className="f">{t("i_email_label")} {t("i_owner_email_opt")}</label>
            <input className="inp" name="ownerEmail" placeholder={t("i_ph_email")} value={ownerEmail} onChange={(event) => setOwnerEmail(event.target.value)} />
            <p className="hint">{t("i_owner_email_hint")}</p>
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
            <input type="radio" name="rentalMode" value="whole_unit" checked={rentalMode === "whole_unit"} onChange={chooseWholeUnit} />
            <span>{t("i_whole_unit")}</span>
          </label>
        </div>
      </div>
      <div hidden={step !== 3}>
        <div className="card pad" style={{ maxWidth: 760 }}>
          <h3>{t("i_sec_rooms")}</h3>
          <p className="hint">{t("i_units_hint")}</p>
          <input type="hidden" name="unitCount" value={wholeUnit ? 1 : 1 + extras.length} />
          <input type="hidden" name="unitLabel" data-testid="unit-label" value={unitLabel || floor} onChange={(event) => setUnitLabel(event.target.value)} />
          <div className="unit-card">
            <div className="grid2">
              <div className={fieldClass("i_floor")}>
                <label className="f">{t("i_floor")}</label>
                <input className="inp" name="floor" data-testid="unit-floor" placeholder={t("i_floor_ph")} value={floor} onChange={(event) => {
                  const next = event.target.value;
                  setFloor(next);
                  setUnitLabel((current) => (current.trim() === "" || current === floor ? next : current));
                  setFieldError("");
                }} />
              </div>
            <div className="fg">
              <label className="f">{t("i_door")} {t("i_owner_email_opt")}</label>
              <input className="inp" name="doorSupplement" placeholder={t("i_door_ph")} value={door} onChange={(event) => setDoor(event.target.value)} />
            </div>
            </div>
            <input type="hidden" name="roomCount" value={wholeUnit ? 1 : rooms.length} />
            {(wholeUnit ? rooms.slice(0, 1) : rooms).map((room, index) => (
              <div className="room-row" key={index}>
                <div className="fg">
                  <label className="f">{t("i_room_name")}</label>
                  <input
                    className="inp"
                    name={`room${index}label`}
                    data-testid={wholeUnit ? "whole-unit-name" : `room-${index}-label`}
                    placeholder={wholeUnit ? "整層" : t(index === 0 ? "i_ph_room_a" : index === 1 ? "i_ph_room_b" : "i_ph_room_c")}
                    value={room.label}
                    onChange={(event) => updateRoom(index, { label: event.target.value })}
                  />
                </div>
                {wholeUnit ? (
                  <input type="hidden" name={`room${index}type`} value="whole_home" />
                ) : (
                <div className={fieldClass("i_room_type")}>
                  <label className="f">{t("i_room_type")}</label>
                  <select
                    className="inp"
                    name={`room${index}type`}
                    data-testid={`room-${index}-type`}
                    value={room.type}
                    onChange={(event) => updateRoom(index, { type: event.target.value })}
                  >
                    <option value="">{t("i_choose")}</option>
                    {ROOM_TYPES.map((type) => (
                      <option key={type} value={type}>
                        {t(TYPE_KEY[type])}
                      </option>
                    ))}
                  </select>
                </div>
                )}
                <div className="fg">
                  <label className="f">{t("i_base_rent")}</label>
                  <input
                    className="inp"
                    name={`room${index}rent`}
                    data-testid={wholeUnit ? "whole-unit-rent" : `room-${index}-rent`}
                    inputMode="decimal"
                    placeholder={t("i_ph_rent")}
                    value={room.rent}
                    onChange={(event) => updateRoom(index, { rent: event.target.value })}
                  />
                </div>
                {wholeUnit ? null : (
                <button className="btn icon" type="button" aria-label={t("i_delete_room")} data-testid={`remove-room-${index}`} onClick={() => setRooms(rooms.filter((_, roomIndex) => roomIndex !== index))}>
                  ×
                </button>
                )}
              </div>
            ))}
            {wholeUnit ? <p className="hint" data-testid="whole-unit-hint">{t("i_whole_unit_hint")}</p> : null}
            {!wholeUnit && wholeHome ? <p className="hint" data-testid="whole-home-hint">{t("i_whole_home_hint")}</p> : null}
            {namedField === "s_8569bc8" || namedField === "i_unit_label" || namedField === "i_floor" ? (
              <p className="errmsg">{t("i_step_incomplete", { field: t(namedField) })}</p>
            ) : null}
            {namedField === "i_room_type" ? (
              <p className="errmsg" data-testid="room-type-error">{t("i_pick_room_type")}</p>
            ) : null}
            {rentalMode === "whole_unit" || wholeHome ? null : (
              <button className="btn" type="button" data-testid="add-room" onClick={() => setRooms([...rooms, emptyRoom()])}>
                {t("s_5035250")}
              </button>
            )}
          </div>
          {wholeUnit ? null : extras.map((unit, index) => {
            const unitIndex = index + 1;
            return (
              <div className="unit-card" key={unitIndex}>
                <input type="hidden" name={`unit${unitIndex}roomCount`} value={unit.rooms.length} />
                <div className="grid2">
                  <div className="fg">
                    <label className="f">{t("i_floor")}</label>
                    <input className="inp" name={`unit${unitIndex}floor`} placeholder={t("i_floor_ph")} value={unit.floor} onChange={(event) => setExtras(extras.map((item, itemIndex) => itemIndex === index ? { ...item, floor: event.target.value } : item))} />
                  </div>
                  <div className="fg">
                    <label className="f">{t("i_door")}</label>
                    <input className="inp" name={`unit${unitIndex}door`} placeholder={t("i_door_ph")} value={unit.door} onChange={(event) => setExtras(extras.map((item, itemIndex) => itemIndex === index ? { ...item, door: event.target.value } : item))} />
                  </div>
                </div>
                {unit.rooms.map((room, roomIndex) => (
                  <div className="room-row" key={roomIndex}>
                    <div className="fg">
                      <label className="f">{t("i_room_name")}</label>
                      <input className="inp" name={`unit${unitIndex}room${roomIndex}label`} value={room.label} onChange={(event) => setExtras(extras.map((item, itemIndex) => itemIndex === index ? { ...item, rooms: item.rooms.map((entry, entryIndex) => entryIndex === roomIndex ? { ...entry, label: event.target.value } : entry) } : item))} />
                    </div>
                    <div className={fieldClass("i_room_type")}>
                      <label className="f">{t("i_room_type")}</label>
                      <select className="inp" name={`unit${unitIndex}room${roomIndex}type`} value={room.type} onChange={(event) => setExtras(extras.map((item, itemIndex) => itemIndex === index ? { ...item, rooms: item.rooms.map((entry, entryIndex) => entryIndex === roomIndex ? { ...entry, type: event.target.value } : entry) } : item))}>
                        <option value="">{t("i_choose")}</option>
                        {ROOM_TYPES.map((type) => (
                          <option key={type} value={type}>{t(TYPE_KEY[type])}</option>
                        ))}
                      </select>
                    </div>
                    <div className="fg">
                      <label className="f">{t("i_base_rent")}</label>
                      <input className="inp" name={`unit${unitIndex}room${roomIndex}rent`} inputMode="decimal" value={room.rent} onChange={(event) => setExtras(extras.map((item, itemIndex) => itemIndex === index ? { ...item, rooms: item.rooms.map((entry, entryIndex) => entryIndex === roomIndex ? { ...entry, rent: event.target.value } : entry) } : item))} />
                    </div>
                    <button className="btn icon" type="button" aria-label={t("i_delete_room")} onClick={() => setExtras(extras.map((item, itemIndex) => itemIndex === index ? { ...item, rooms: item.rooms.filter((_, entryIndex) => entryIndex !== roomIndex) } : item))}>×</button>
                  </div>
                ))}
              </div>
            );
          })}
          {wholeUnit ? null : (
          <button className="btn" type="button" data-testid="add-unit" onClick={() => setExtras([...extras, { floor: "", door: "", rooms: [emptyRoom()] }])}>
            + {t("i_add_unit")}
          </button>
          )}
        </div>
      </div>
      <div hidden={step !== 4}>
        <div className="card pad" style={{ maxWidth: 760 }}>
          <h3>{t("i_sec_meter")}</h3>
          <div className="fg">
            <label className="f">{t("i_split")}</label>
            <select
              className="inp"
              name="electricSplit"
              data-testid="property-split"
              value={split}
              onKeyDown={(event) => {
                if (event.key === "Enter") event.preventDefault();
              }}
              onChange={(event) => setSplit(event.target.value)}
            >
              <option value="">{t("i_choose")}</option>
              <option value="even">{t("i_split_even")}</option>
              <option value="sub">{t("i_split_sub")}</option>
              <option value="reading">{t("i_elec_reading")}</option>
              <option value="days">{t("i_split_days")}</option>
              <option value="owner">{t("i_split_owner")}</option>
            </select>
          </div>
          {split === "owner" ? null : (
          <div className="fg">
            <label className="f">{t("i_rate")}</label>
            <input className="inp" name="electricRate" data-testid="property-rate" inputMode="decimal" placeholder={t("i_ph_rate")} value={rate} onChange={(event) => setRate(event.target.value)} />
          </div>
          )}
          {split === "sub" ? (
            <div className="fg">
              <label className="f">{t("i_opening_kwh")} {t("i_opening_opt")}</label>
              {rooms.map((room, index) => (
                <label className="opening-row" key={index}>
                  <span>{[floor, door, room.label].filter((part) => part.trim()).join(" ") || room.label || String(index + 1)}</span>
                  <input
                    className="inp"
                    name={`room${index}opening`}
                    inputMode="decimal"
                    value={room.opening}
                    onChange={(event) => updateRoom(index, { opening: event.target.value })}
                  />
                </label>
              ))}
            </div>
          ) : null}
          <p className="note">{t("i_elec_monthly_note")}</p>
          {split === "owner" ? null : (
          <div className="example" data-testid="example-calc">
            <div className="row">
              <h3>{t("i_example_calc")}</h3>
              <span className="chip">{t("i_example_note")}</span>
            </div>
            <table className="t">
              <tbody>
                {preview.map((row, index) => (
                  <tr key={index}>
                    <td>{row.label}</td>
                    <td>{t("i_example_kwh", { kwh: row.kwh })}</td>
                    <td className="num">{money(row.amount, currency, locale)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          )}
        </div>
      </div>
      {state.error && !namedField ? <p className="errmsg" data-testid="property-save-error">{errorText(t, state.error)}</p> : null}
      <div className="row" style={{ marginTop: 16, maxWidth: 760 }}>
        {step > 1 ? (
          <button className="btn" type="button" onClick={goBack}>
            ← {t("s_5bf6faa")}
          </button>
        ) : null}
        <span className="sp" />
        {step < 4 ? (
          <button key="wizard-next" className="btn pri" type="button" data-testid="wizard-next" disabled={blocked || (step === 2 && !rentalMode) || (step === 1 && !ownerMode)} onClick={goNext}>
            {t("s_9cff86c")} →
          </button>
        ) : (
          <button key="submit-property" className="btn pri" type="submit" data-testid="submit-property" data-saving={saving ? "1" : undefined} disabled={blocked || !submitReady} aria-busy={saving ? true : undefined}>
            {saving ? t("i_portal_working") : t("s_aed91da")}
          </button>
        )}
      </div>
    </form>
  );
}
