import React from "react";
import type { Locale } from "../../i18n";
import { brandV3Copy } from "../../i18n/lanes/brand-v3";

export function RoleAvatar({ role, locale, name }: {
  role: "m" | "t" | "o" | "v"; locale: Locale; name?: string;
}) {
  const copy = brandV3Copy(locale);
  const trimmed = name?.trim();
  // CJK family names lead; Latin display names put the family name last.
  const surname = trimmed && (/^\p{Script=Han}/u.test(trimmed)
    ? Array.from(trimmed)[0] : Array.from(trimmed.split(/\s+/).at(-1)!)[0].toLocaleUpperCase(locale));
  const glyph = surname || { m: "管", t: "租", o: "屋", v: "廠" }[role];
  const label = trimmed ? copy.account.replace("{role}", copy[role]).replace("{name}", trimmed) : copy[role];
  return <span role="img" className={`party party-${role}${trimmed ? " party-name" : ""}`} aria-label={label}>{glyph}</span>;
}
