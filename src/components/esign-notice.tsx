"use client";

import { useSearchParams } from "next/navigation";
import { esignUi } from "@/i18n/lanes/esign";

export function EsignNotice({ locale }: { locale: "zh-TW" | "en" }) {
  const search = useSearchParams();
  return search.get("esignError") === "1" ? <p role="alert">{esignUi[locale].failed}</p> : null;
}
