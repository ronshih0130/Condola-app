"use client";

import { Children, useState, type ReactNode } from "react";
import { esignUi } from "@/i18n/lanes/esign";

export function EsignVersions({ children, statuses, filter, locale }: {
  children: ReactNode; statuses: string[]; filter: boolean; locale: "zh-TW" | "en";
}) {
  const [selected, setSelected] = useState("");
  const c = esignUi[locale];
  return <div style={{ minWidth: 0 }}>
    {filter && statuses.length ? <label>{c.filter}<select className="inp" value={selected} onChange={(e) => setSelected(e.target.value)}>
      <option value="">{c.all}</option>
      {Array.from(new Set(statuses)).map((s) => <option key={s} value={s}>{c[(s === "sent" ? "sentStatus" : s) as keyof typeof c] ?? s}</option>)}
    </select></label> : null}
    {Children.toArray(children).map((child, i) => !selected || !filter || statuses[i] === selected ? child : null)}
  </div>;
}
