"use client";

import React, { useEffect } from "react";
import { makeT, type Locale } from "../../../../i18n";

/** Consume only signup-result parameters after showing their existing copy once. */
export function SignupNotice({ query, locale }: { query: { dupFirm?: string; code?: string }; locale: Locale }) {
  useEffect(() => {
    const url = new URL(window.location.href);
    let consumed = false;
    if (query.dupFirm === "1" && url.searchParams.get("dupFirm") === "1") { url.searchParams.delete("dupFirm"); consumed = true; }
    if (query.code === "list" && url.searchParams.get("code") === "list") { url.searchParams.delete("code"); consumed = true; }
    if (consumed) window.history.replaceState(window.history.state, "", `${url.pathname}${url.search}${url.hash}`);
  }, [query.dupFirm, query.code]);
  const t = makeT(locale);
  if (query.dupFirm !== "1" && query.code !== "list") return null;
  return <aside className="v3-today-notice" role="status">
    {query.dupFirm === "1" && <p data-testid="dup-firm">{t("i_signup_dup_firm")}</p>}
    {query.code === "list" && <p data-testid="code-list">{t("i_signup_code_list")}</p>}
  </aside>;
}
