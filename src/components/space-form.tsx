"use client";

import { useState } from "react";
import { displaySampleName } from "@/sample-name";
import { useT } from "./locale";

const ROOM_TYPES = ["whole_home", "studio", "suite", "shared_bath", "other"] as const;
const TYPE_KEY: Record<string, string> = {
  whole_home: "i_whole_home",
  suite: "i_room_split",
  shared_bath: "i_shared",
  studio: "i_studio",
  other: "i_other_room",
};

export type SpaceFormValues = {
  propertyId: string;
  ownerContactId: string;
  kind: "room" | "whole_unit";
  floor: string;
  roomLabel: string;
  roomType: string;
  area: string;
  rent: string;
  electricityMethod: string;
  ratePerKwh: string;
  rateCapReason: string;
  taipowerKwh: string;
  taipowerAmount: string;
  notes: string;
};

const EMPTY: SpaceFormValues = {
  propertyId: "",
  ownerContactId: "",
  kind: "room",
  floor: "",
  roomLabel: "",
  roomType: "",
  area: "",
  rent: "",
  electricityMethod: "",
  ratePerKwh: "",
  rateCapReason: "",
  taipowerKwh: "",
  taipowerAmount: "",
  notes: "",
};

export function SpaceForm({
  action,
  properties,
  owners,
  defaults,
  lockProperty,
  lockKind,
  propertyName,
  spaceId,
  locked,
}: {
  action: (formData: FormData) => void;
  properties: { id: string; name: string }[];
  owners: { id: string; name: string }[];
  defaults?: Partial<SpaceFormValues>;
  lockProperty?: boolean;
  lockKind?: boolean;
  propertyName?: string;
  spaceId?: string;
  locked?: boolean;
}) {
  const t = useT();
  const initial = { ...EMPTY, ...defaults };
  const [kind, setKind] = useState(initial.kind);
  const [propertyId, setPropertyId] = useState(initial.propertyId);
  const [ownerId, setOwnerId] = useState(initial.ownerContactId);
  const [roomType, setRoomType] = useState(initial.roomType);
  const [electricity, setElectricity] = useState(initial.electricityMethod);

  return (
    <form action={action}>
      {spaceId ? <input type="hidden" name="spaceId" value={spaceId} /> : null}
      <input type="hidden" name="kind" value={kind} />
      <div className="card pad" style={{ maxWidth: 760 }}>
        <div className="fg">
          <label className="f">{t("i_space_kind")}</label>
          <label className="radio">
            <input
              type="radio"
              data-testid="space-kind-room"
              checked={kind === "room"}
              disabled={lockKind}
              onChange={() => setKind("room")}
            />
            <span>{t("i_space_room")}</span>
          </label>
          <label className="radio">
            <input
              type="radio"
              data-testid="space-kind-whole"
              checked={kind === "whole_unit"}
              disabled={lockKind}
              onChange={() => setKind("whole_unit")}
            />
            <span>{t("i_space_whole")}</span>
          </label>
        </div>
        <div className="fg">
          <label className="f">{t("i_property_name")}</label>
          {lockProperty ? (
            <>
              <input type="hidden" name="propertyId" value={propertyId} />
              <p data-testid="space-property-name">{propertyName}</p>
            </>
          ) : (
            <select
              className="inp"
              name="propertyId"
              data-testid="space-property"
              value={propertyId}
              onChange={(event) => setPropertyId(event.target.value)}
            >
              <option value="">{t("i_choose")}</option>
              {properties.map((property) => (
                <option key={property.id} value={property.id}>
                  {displaySampleName(property.name)}
                </option>
              ))}
            </select>
          )}
        </div>
        <div className="fg">
          <label className="f">{t("i_owner")}</label>
          <select
            className="inp"
            name="ownerContactId"
            data-testid="space-owner"
            value={ownerId}
            onChange={(event) => setOwnerId(event.target.value)}
          >
            <option value="">{t("i_choose")}</option>
            {owners.map((owner) => (
              <option key={owner.id} value={owner.id}>
                {owner.name}
              </option>
            ))}
          </select>
        </div>
        <div className="grid2">
          <div className="fg">
            <label className="f">{t("i_floor_unit")}</label>
            <input className="inp" name="floor" data-testid="space-floor" defaultValue={initial.floor} placeholder={t("i_ph_floor_unit")} />
          </div>
          {kind === "room" ? (
            <div className="fg">
              <label className="f">{t("i_room_no")}</label>
              <input className="inp" name="roomLabel" data-testid="space-room" defaultValue={initial.roomLabel} placeholder={t("i_ph_room_a")} />
            </div>
          ) : null}
        </div>
        {kind === "room" ? (
          <div className="fg">
            <label className="f">{t("i_room_type")}</label>
            <select className="inp" name="roomType" data-testid="space-type" value={roomType} onChange={(event) => setRoomType(event.target.value)}>
              <option value="">{t("i_choose")}</option>
              {ROOM_TYPES.map((type) => (
                <option key={type} value={type}>
                  {t(TYPE_KEY[type])}
                </option>
              ))}
            </select>
          </div>
        ) : null}
        <div className="grid2">
          <div className="fg">
            <label className="f">{t("i_area_ping")}</label>
            <input className="inp" name="area" data-testid="space-area" inputMode="decimal" defaultValue={initial.area} placeholder={t("i_ph_area")} />
          </div>
          <div className="fg">
            <label className="f">{t("i_base_rent")}</label>
            <input className="inp" name="rent" data-testid="space-rent" inputMode="decimal" defaultValue={initial.rent} placeholder={t("i_ph_rent")} />
          </div>
        </div>
        <div className="grid2">
          <div className="fg">
            <label className="f">{t("i_elec_method")}</label>
            <select
              className="inp"
              name="electricityMethod"
              data-testid="space-electricity"
              value={electricity}
              onChange={(event) => setElectricity(event.target.value)}
            >
              <option value="">{t("i_choose")}</option>
              <option value="submeter">{t("i_elec_submeter")}</option>
              <option value="by_reading">{t("i_elec_reading")}</option>
              <option value="shared">{t("i_elec_shared")}</option>
              <option value="tenant_direct">{t("i_elec_direct")}</option>
            </select>
          </div>
          <div className="fg">
            <label className="f">{t("i_rate")}</label>
            <input className="inp" name="ratePerKwh" data-testid="space-rate" inputMode="decimal" defaultValue={initial.ratePerKwh} placeholder={t("i_ph_rate")} />
          </div>
        </div>
        <div className="fg">
          <label className="f">{t("i_rate_reason")}</label>
          <input className="inp" name="rateCapReason" data-testid="space-rate-reason" defaultValue={initial.rateCapReason} />
        </div>
        <div className="grid2">
          <div className="fg">
            <label className="f">{t("i_usage")}</label>
            <input className="inp" name="taipowerKwh" data-testid="space-kwh" inputMode="decimal" defaultValue={initial.taipowerKwh} />
          </div>
          <div className="fg">
            <label className="f">{t("i_bill_total")}</label>
            <input className="inp" name="taipowerAmount" data-testid="space-bill" inputMode="decimal" defaultValue={initial.taipowerAmount} />
          </div>
        </div>
        <div className="fg">
          <label className="f">{t("i_note")}</label>
          <textarea className="inp" name="notes" data-testid="space-notes" rows={3} defaultValue={initial.notes} />
        </div>
        {locked ? (
          <button
            className="btn pri"
            type="button"
            disabled
            aria-disabled="true"
            data-testid="save-space"
            data-i18n-key="i_readonly_edit_pending"
            title={t("i_readonly_edit_pending")}
          >
            {t("i_save")}
          </button>
        ) : (
          <button className="btn pri" type="submit" data-testid="save-space">
            {t("i_save")}
          </button>
        )}
      </div>
    </form>
  );
}
