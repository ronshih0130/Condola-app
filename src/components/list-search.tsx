import Link from "next/link";

export function listHref(path: string, q: string, page: number) {
  const params = new URLSearchParams();
  if (q) params.set("q", q);
  if (page > 1) params.set("page", String(page));
  const query = params.toString();
  return query ? `${path}?${query}` : path;
}

export function ListSearch({
  action,
  q,
  label,
  placeholder,
}: {
  action: string;
  q: string;
  label: string;
  placeholder: string;
}) {
  return (
    <form className="filters" method="get" action={action} data-testid="list-search-form">
      <label className="f" htmlFor="list-q">
        {label}
      </label>
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
}: {
  path: string;
  q: string;
  page: number;
  hasNext: boolean;
  prevLabel: string;
  nextLabel: string;
}) {
  if (page <= 1 && !hasNext) return null;
  return (
    <div className="row" data-testid="list-pager" data-page={page} style={{ marginTop: 12 }}>
      {page > 1 ? (
        <Link className="btn" href={listHref(path, q, page - 1)} data-testid="list-prev">
          {prevLabel}
        </Link>
      ) : null}
      <span className="sp" />
      {hasNext ? (
        <Link className="btn" href={listHref(path, q, page + 1)} data-testid="list-next">
          {nextLabel}
        </Link>
      ) : null}
    </div>
  );
}
