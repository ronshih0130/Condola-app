"use client";

import { createContext, useContext } from "react";
import { makeT, type Locale, type T } from "@/i18n";

const LocaleContext = createContext<Locale>("zh-TW");

export function LocaleProvider({ locale, children }: { locale: Locale; children: React.ReactNode }) {
  return <LocaleContext.Provider value={locale}>{children}</LocaleContext.Provider>;
}

export function useLocale() {
  return useContext(LocaleContext);
}

export function useT(): T {
  return makeT(useContext(LocaleContext));
}
