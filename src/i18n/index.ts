import en from "./en.json";
import zh from "./zh-TW.json";

export type Locale = "zh-TW" | "en";
export type Dict = Record<string, string>;

const dictionaries: Record<Locale, Dict> = {
  "zh-TW": zh,
  en,
};

export function isLocale(value: string | undefined | null): value is Locale {
  return value === "zh-TW" || value === "en";
}

export function dictionary(locale: Locale): Dict {
  return dictionaries[locale];
}

export function translate(dict: Dict, key: string, vars?: Record<string, string | number>) {
  let text = dict[key] ?? key;
  if (vars) {
    for (const [name, value] of Object.entries(vars)) {
      text = text.replaceAll(`{${name}}`, String(value));
    }
  }
  return text;
}

export function makeT(locale: Locale) {
  const dict = dictionary(locale);
  return (key: string, vars?: Record<string, string | number>) => translate(dict, key, vars);
}

export type T = ReturnType<typeof makeT>;
