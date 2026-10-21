import Link from "next/link";
import { listHref } from "@/server/list-search";

export function listSummary(
  t: (key: string, vars?: Record<string, string | number>) => string,
  page: { total: number; from: number; to: number },
) {
  if (page.from === 0) return t("i_search_total", { total: page.total });
  return t("i_search_range", { from: page.from, to: page.to, total: page.total });
}

export function ListSearch({
  action,
  q,
  label,
  placeholder,
  clearLabel,
}: {
  action: string;
  q: string;
  label: string;
  placeholder: string;
  clearLabel: string;
}) {
  return (
    <form className="filters" method="get" action={action} data-testid="list-search-form">
      <label className="f" htmlFor="list-q">
        {label}
      </label>
      <span className="qbox">
        <input
          id="list-q"
          className="inp"
          name="q"
          defaultValue={q}
          placeholder={placeholder}
          data-testid="list-search"
          autoComplete="off"
          enterKeyHint="search"
        />
        {q ? (
          <Link href={action} className="qclear" data-testid="list-search-clear" aria-label={clearLabel}>
            ×
          </Link>
        ) : null}
      </span>
      <button className="btn" type="submit">
        {label}
      </button>
    </form>
  );
}

export function ListPager({
  path,
  q,
  page,
  hasNext,
  prevLabel,
  nextLabel,
  summary,
  total,
  from,
  to,
}: {
  path: string;
  q: string;
  page: number;
  hasNext: boolean;
  prevLabel: string;
  nextLabel: string;
  summary: string;
  total: number;
  from: number;
  to: number;
}) {
  return (
    <div className="row" data-testid="list-pager" data-page={page} style={{ marginTop: 12 }}>
      <span data-testid="list-summary" data-total={total} data-from={from} data-to={to}>
        {summary}
      </span>
      <span className="sp" />
      {page > 1 ? (
        <Link className="btn" href={listHref(path, q, page - 1)} data-testid="list-prev">
          {prevLabel}
        </Link>
      ) : null}
      {hasNext ? (
        <Link className="btn" href={listHref(path, q, page + 1)} data-testid="list-next">
          {nextLabel}
        </Link>
      ) : null}
    </div>
  );
}
