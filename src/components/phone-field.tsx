"use client";

import type { ChangeEvent } from "react";
import { offeredCountries } from "@/countries";
import { useT } from "./locale";

export function PhoneField({
  name,
  testId,
  value,
  defaultValue,
  onChange,
  callingCode,
  onCallingCode,
  invalid,
}: {
  name?: string;
  testId?: string;
  value?: string;
  defaultValue?: string;
  onChange?: (value: string) => void;
  callingCode: string;
  onCallingCode?: (code: string) => void;
  invalid?: boolean;
}) {
  const t = useT();
  const countries = offeredCountries();
  const selectName = name ? `${name}Country` : "phoneCountry";
  const controlled = value !== undefined;
  return (
    <div className={`phone-row${invalid ? " err" : ""}`}>
      <select
        className="inp"
        name={selectName}
        aria-label={t("i_country")}
        value={callingCode}
        onChange={(event) => onCallingCode?.(event.target.value)}
      >
        {countries.map((country) => (
          <option key={country.code} value={country.callingCode}>
            {country.callingCode}
          </option>
        ))}
      </select>
      <input
        className="inp"
        name={name}
        data-testid={testId}
        inputMode="tel"
        {...(controlled
          ? { value, onChange: (event: ChangeEvent<HTMLInputElement>) => onChange?.(event.target.value) }
          : { defaultValue })}
      />
    </div>
  );
}
