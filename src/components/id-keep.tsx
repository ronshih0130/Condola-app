"use client";

import Link from "next/link";
import { useLocale, useT } from "./locale";

/** The confirmed retention sentence. The post-submit page links 告知事項; the admin card does not. */
export function IdKeepNotice({ link }: { link?: string }) {
  const t = useT();
  const locale = useLocale();
  const sentence = t("i_id_keep_notice");
  const token = locale === "en" ? "privacy notice" : "告知事項";
  const at = link ? sentence.indexOf(token) : -1;
  return (
    <p className="small" data-testid="idv-keep">
      {at < 0 ? (
        sentence
      ) : (
        <>
          {sentence.slice(0, at)}
          <Link href={link ?? "/t/id/notice"}>{token}</Link>
          {sentence.slice(at + token.length)}
        </>
      )}
    </p>
  );
}
