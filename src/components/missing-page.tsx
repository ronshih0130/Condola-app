import Link from "next/link";
import { makeT } from "@/i18n";

export function MissingPage({ href }: { href: "/" | "/m" }) {
  const t = makeT("zh-TW");
  return (
    <div className="card pad missing" data-testid="not-found">
      <h1>{t("i_page_missing_title")}</h1>
      <p>{t("i_page_missing_body")}</p>
      <Link className="btn pri" href={href} data-testid="not-found-home">
        {t("i_page_missing_home")}
      </Link>
    </div>
  );
}
